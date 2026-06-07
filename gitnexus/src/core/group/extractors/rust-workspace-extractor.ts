import fs from 'node:fs/promises';
import path from 'node:path';
import type { CypherExecutor } from '../contract-extractor.js';
import type { GroupManifestLink, ContractRole } from '../types.js';
import { shouldIgnorePath } from '../../../config/ignore-service.js';
import { loadIgnoreRules } from '../../../config/ignore-service.js';

import { logger } from '../../logger.js';
/**
 * Discover cross-crate contracts in a Rust workspace by reading each
 * member's `Cargo.toml` dependencies and scanning source files for
 * `use <workspace_dep>::<Type>` imports.
 *
 * Emits `GroupManifestLink[]` with `type: 'custom'` that feed into the
 * existing ManifestExtractor pipeline — no new matching logic needed.
 *
 * Designed for the group-level sync pipeline: it receives all repos in
 * a group and produces cross-repo links between them.
 */

interface CrateMeta {
  name: string;
  groupPath: string;
  repoPath: string;
  workspaceDeps: string[];
}

interface ImportedSymbol {
  crateName: string;
  symbolName: string;
  filePath: string;
}

/**
 * Linear-time `[package].name = "..."` lookup. The previous regex
 * `^\[package\]\s*\n(?:[^\[]*?\n)*?name\s*=\s*"([^"]+)"` had a nested
 * lazy quantifier on `\n` that CodeQL js/redos flagged as exponential
 * on inputs like `[package]\n` + many bare `\n`. We walk lines
 * explicitly: scan from the first `[package]` header until we hit the
 * next `[...]` section header, looking for the `name = "..."` line.
 * O(n) with the line count.
 *
 * Exported so the U8 ReDoS regression test can drive the production
 * line-walk directly with adversarial fixtures (multi-line strings,
 * trailing sections, etc.) instead of duplicating it inline.
 */
export function parseCargoPackageName(content: string): string | null {
  let inPackage = false;
  let lineStart = 0;

  while (lineStart <= content.length) {
    const newline = content.indexOf('\n', lineStart);
    const lineEnd = newline === -1 ? content.length : newline;

    if (!inPackage) {
      if (isTrimmedLine(content, lineStart, lineEnd, '[package]')) {
        inPackage = true;
      }
    } else {
      const first = firstNonWhitespace(content, lineStart, lineEnd);
      if (first < lineEnd && content[first] === '[') break;
      const name = parsePackageNameLine(content, first, lineEnd);
      if (name !== null) return name;
    }

    if (newline === -1) break;
    lineStart = newline + 1;
  }

  return null;
}

function isTrimmedLine(content: string, start: number, end: number, expected: string): boolean {
  const left = firstNonWhitespace(content, start, end);
  let right = end;
  while (right > left && isAsciiWhitespace(content.charCodeAt(right - 1))) right--;
  return right - left === expected.length && content.startsWith(expected, left);
}

function parsePackageNameLine(content: string, start: number, end: number): string | null {
  if (!content.startsWith('name', start)) return null;
  let pos = start + 'name'.length;
  if (pos < end && !isAsciiWhitespace(content.charCodeAt(pos)) && content[pos] !== '=') {
    return null;
  }
  pos = firstNonWhitespace(content, pos, end);
  if (pos >= end || content[pos] !== '=') return null;
  pos = firstNonWhitespace(content, pos + 1, end);
  if (pos >= end || content[pos] !== '"') return null;
  const valueStart = pos + 1;
  let valueEnd = valueStart;
  while (valueEnd < end && content[valueEnd] !== '"') valueEnd++;
  if (valueEnd >= end) return null;
  return content.slice(valueStart, valueEnd);
}

function firstNonWhitespace(content: string, start: number, end: number): number {
  let pos = start;
  while (pos < end && isAsciiWhitespace(content.charCodeAt(pos))) pos++;
  return pos;
}

function isAsciiWhitespace(code: number): boolean {
  return code === 9 || code === 10 || code === 11 || code === 12 || code === 13 || code === 32;
}

/**
 * Parse a Cargo.toml to extract the crate name and workspace dependency
 * names. Uses simple line-based parsing — no TOML library needed for
 * the subset we care about.
 */
async function parseCrateManifest(
  repoPath: string,
): Promise<{ name: string; workspaceDeps: string[] } | null> {
  const cargoPath = path.join(repoPath, 'Cargo.toml');
  let content: string;
  try {
    content = await fs.readFile(cargoPath, 'utf-8');
  } catch {
    return null;
  }

  const name = parseCargoPackageName(content) ?? '';
  const workspaceDeps: string[] = [];

  // Match dependencies that use workspace = true, which indicates they
  // are workspace-internal deps:
  //   dep_name = { workspace = true }
  //   dep_name.workspace = true
  //
  // Also match plain path dependencies:
  //   dep_name = { path = "../other" }
  const depSections = content.matchAll(
    /\[(dependencies|dev-dependencies|build-dependencies)\]\s*\n([\s\S]*?)(?=\n\[|$)/g,
  );

  for (const section of depSections) {
    const sectionBody = section[2];
    // workspace = true style
    const wsMatches = sectionBody.matchAll(
      /^(\w[\w-]*)\s*=\s*\{[^}]*workspace\s*=\s*true[^}]*\}/gm,
    );
    for (const m of wsMatches) workspaceDeps.push(m[1]);

    // dotted workspace style: dep_name.workspace = true
    const dottedMatches = sectionBody.matchAll(/^(\w[\w-]*)\.workspace\s*=\s*true/gm);
    for (const m of dottedMatches) workspaceDeps.push(m[1]);

    // path = "../other" style (local path deps within workspace)
    const pathMatches = sectionBody.matchAll(
      /^(\w[\w-]*)\s*=\s*\{[^}]*path\s*=\s*"[^"]*"[^}]*\}/gm,
    );
    for (const m of pathMatches) workspaceDeps.push(m[1]);
  }

  if (!name) return null;
  return { name, workspaceDeps: [...new Set(workspaceDeps)] };
}

/**
 * Scan Rust source files for `use <crate>::<path>::<Symbol>` patterns
 * where <crate> is a known workspace dependency.
 */
async function scanImports(repoPath: string, knownCrates: Set<string>): Promise<ImportedSymbol[]> {
  const results: ImportedSymbol[] = [];

  const normalizedCrates = new Map<string, string>();
  for (const c of knownCrates) {
    normalizedCrates.set(c.replace(/-/g, '_'), c);
  }

  const sourceFiles = await findRustFiles(repoPath);
  for (const relFile of sourceFiles) {
    const absPath = path.join(repoPath, relFile);
    let content: string;
    try {
      content = await fs.readFile(absPath, 'utf-8');
    } catch {
      continue;
    }

    // Match patterns:
    //   use crate_name::Type;
    //   use crate_name::module::Type;
    //   use crate_name::{Type1, Type2};
    //   use crate_name::module::{Type1, Type2};
    const useRegex = /^use\s+(\w+)::(.+);/gm;
    let match;
    while ((match = useRegex.exec(content)) !== null) {
      const crateName = match[1];
      const originalCrateName = normalizedCrates.get(crateName);
      if (!originalCrateName) continue;

      const importPath = match[2].trim();

      // Handle grouped imports: {Type1, Type2, module::Type3}
      const braceMatch = importPath.match(/\{([^}]+)\}/);
      if (braceMatch) {
        const items = braceMatch[1].split(',').map((s) => s.trim());
        for (const item of items) {
          const symbolName = extractSymbolName(item);
          if (symbolName && isTypeName(symbolName)) {
            results.push({ crateName: originalCrateName, symbolName, filePath: relFile });
          }
        }
      } else {
        const symbolName = extractSymbolName(importPath);
        if (symbolName && isTypeName(symbolName)) {
          results.push({ crateName: originalCrateName, symbolName, filePath: relFile });
        }
      }
    }
  }

  return results;
}

/** Extract the final symbol name from a path like `module::submod::TypeName`. */
function extractSymbolName(importPath: string): string | null {
  const trimmed = importPath.trim();
  if (!trimmed || trimmed === '*' || trimmed === 'self') return null;
  const parts = trimmed.split('::');
  return parts[parts.length - 1].trim() || null;
}

/**
 * Heuristic: in Rust, types (structs, enums, traits) are PascalCase.
 * Functions and modules are snake_case. We only want types as cross-crate
 * contracts — functions are too granular and modules too broad.
 */
function isTypeName(name: string): boolean {
  return /^[A-Z][A-Za-z0-9]*$/.test(name);
}

async function findRustFiles(repoPath: string): Promise<string[]> {
  const results: string[] = [];
  const ig = await loadIgnoreRules(repoPath);

  async function walk(dir: string, rel: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel + '/')) continue;
        await walk(path.join(dir, entry.name), childRel);
      } else if (entry.name.endsWith('.rs')) {
        if (shouldIgnorePath(childRel)) continue;
        if (ig && ig.ignores(childRel)) continue;
        results.push(childRel);
      }
    }
  }

  await walk(repoPath, '');
  return results;
}

export interface RustWorkspaceResult {
  links: GroupManifestLink[];
  discoveredCrates: Map<string, CrateMeta>;
}

/**
 * Discover cross-crate contracts across all Rust repos in a group.
 *
 * Returns `GroupManifestLink[]` ready to feed into `ManifestExtractor`.
 */
export async function extractRustWorkspaceLinks(
  repos: Record<string, string>,
  repoPaths: Map<string, string>,
  _dbExecutors?: Map<string, CypherExecutor>,
): Promise<RustWorkspaceResult> {
  // Phase 1: Parse all Cargo.toml files to build crate registry
  const cratesByName = new Map<string, CrateMeta>();
  const cratesByGroupPath = new Map<string, CrateMeta>();

  for (const [groupPath] of Object.entries(repos)) {
    const repoPath = repoPaths.get(groupPath);
    if (!repoPath) continue;

    const manifest = await parseCrateManifest(repoPath);
    if (!manifest) continue;

    const meta: CrateMeta = {
      name: manifest.name,
      groupPath,
      repoPath,
      workspaceDeps: manifest.workspaceDeps,
    };
    const existing = cratesByName.get(manifest.name);
    if (existing) {
      logger.warn(
        `[rust-workspace-extractor] duplicate crate name "${manifest.name}" in "${groupPath}" and "${existing.groupPath}" — skipping "${groupPath}"`,
      );
      continue;
    }
    cratesByName.set(manifest.name, meta);
    cratesByGroupPath.set(groupPath, meta);
  }

  // Phase 2: For each crate, identify which of its workspace deps are
  // also in this group (i.e., repos we can link to)
  const links: GroupManifestLink[] = [];
  const seen = new Set<string>();

  for (const [, crate] of cratesByGroupPath) {
    const groupCrateDeps = crate.workspaceDeps.filter((d) => cratesByName.has(d));
    if (groupCrateDeps.length === 0) continue;

    // Phase 3: Scan source files for imports from workspace deps
    const knownCrates = new Set(groupCrateDeps);
    const imports = await scanImports(crate.repoPath, knownCrates);

    for (const imp of imports) {
      const providerCrate = cratesByName.get(imp.crateName);
      if (!providerCrate) continue;

      const qualifiedContract = `${imp.crateName}::${imp.symbolName}`;
      const key = `${crate.groupPath}→${providerCrate.groupPath}::${qualifiedContract}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const link: GroupManifestLink = {
        from: providerCrate.groupPath,
        to: crate.groupPath,
        type: 'custom',
        contract: qualifiedContract,
        role: 'provider' as ContractRole,
      };
      links.push(link);
    }
  }

  return { links, discoveredCrates: cratesByGroupPath };
}
