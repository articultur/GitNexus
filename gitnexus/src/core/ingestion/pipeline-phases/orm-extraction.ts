/**
 * Inline ORM query extraction (sequential fallback path).
 *
 * Extracts Prisma and Supabase query calls from source content using
 * regex patterns. Used by the sequential parse path when workers are
 * not available — the worker path extracts ORM queries via tree-sitter
 * queries instead.
 *
 * @module
 */

import type { ExtractedORMQuery } from '../workers/parse-worker.js';

// ── Regex patterns ─────────────────────────────────────────────────────────

/** Matches Prisma client method calls: `prisma.user.findMany(...)` */
const PRISMA_QUERY_RE =
  /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|delete|deleteMany|upsert|count|aggregate|groupBy)\s*\(/g;

/** Matches Supabase client method calls: `supabase.from('users').select(...)` */
const SUPABASE_QUERY_RE =
  /\bsupabase\.from\s*\(\s*['"](\w+)['"]\s*\)\s*\.(select|insert|update|delete|upsert)\s*\(/g;

// ── HarmonyOS RDB / Preferences patterns ───────────────────────────────────

const HARMONY_RDB_PREDICATE_RE =
  /\b(?:const|let|var)\s+(\w+)\s*=\s*new\s+(?:rdb|relationalStore)\.RdbPredicates\s*\(\s*['"]([\w$-]+)['"]\s*\)/g;
const HARMONY_RDB_QUERY_RE = /\b\w+\.(query|querySync)\s*\(\s*(\w+)/g;
const HARMONY_RDB_INLINE_QUERY_RE =
  /\b\w+\.(query|querySync)\s*\(\s*new\s+(?:rdb|relationalStore)\.RdbPredicates\s*\(\s*['"]([\w$-]+)['"]\s*\)/g;
const HARMONY_RDB_SQL_RE = /\b\w+\.(querySql|executeSql)\s*\(\s*(['"`])([\s\S]*?)\2/g;
const HARMONY_PREFERENCES_STORE_RE =
  /\b(?:const|let|var)\s+(\w+)\s*=\s*(?:await\s+)?preferences\.getPreferences(?:Sync)?\s*\(/g;
const HARMONY_PREFERENCES_GET_RE = /\b(\w+)\.(get|getSync)\s*\(\s*['"]([^'"]+)['"]/g;

// ── Extraction function ───────────────────────────────────────────────────

/**
 * Extract ORM query calls from file content using regex.
 *
 * Fast-path: skips files that don't contain `prisma.` or `supabase.from`.
 * Results are appended to the `out` array (push pattern avoids allocation).
 *
 * @param filePath  Relative path of the source file
 * @param content   File content string
 * @param out       Output array to append extracted queries to
 */
export function extractORMQueriesInline(
  filePath: string,
  content: string,
  out: ExtractedORMQuery[],
): void {
  const hasPrisma = content.includes('prisma.');
  const hasSupabase = content.includes('supabase.from');
  const hasRdb =
    content.includes('RdbPredicates') ||
    content.includes('.querySql(') ||
    content.includes('.executeSql(');
  const hasPreferences = content.includes('preferences.getPreferences');
  if (!hasPrisma && !hasSupabase && !hasRdb && !hasPreferences) return;

  // Pre-compute line number offsets to avoid O(n²) substring+split per match
  const lineOffsets = buildLineOffsets(content);

  if (hasPrisma) {
    PRISMA_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = PRISMA_QUERY_RE.exec(content)) !== null) {
      const model = m[1];
      if (model.startsWith('$')) continue;
      out.push({
        filePath,
        orm: 'prisma',
        model,
        method: m[2],
        lineNumber: lineNumberAtOffset(lineOffsets, m.index),
      });
    }
  }

  if (hasSupabase) {
    SUPABASE_QUERY_RE.lastIndex = 0;
    let m;
    while ((m = SUPABASE_QUERY_RE.exec(content)) !== null) {
      out.push({
        filePath,
        orm: 'supabase',
        model: m[1],
        method: m[2],
        lineNumber: lineNumberAtOffset(lineOffsets, m.index),
      });
    }
  }

  extractHarmonyQueries(filePath, content, lineOffsets, out);
}

function extractHarmonyQueries(
  filePath: string,
  content: string,
  lineOffsets: readonly number[],
  out: ExtractedORMQuery[],
): void {
  const predicateTables = new Map<string, string>();
  HARMONY_RDB_PREDICATE_RE.lastIndex = 0;
  let m;
  while ((m = HARMONY_RDB_PREDICATE_RE.exec(content)) !== null) {
    predicateTables.set(m[1], m[2]);
  }

  HARMONY_RDB_QUERY_RE.lastIndex = 0;
  while ((m = HARMONY_RDB_QUERY_RE.exec(content)) !== null) {
    const model = predicateTables.get(m[2]);
    if (model === undefined) continue;
    out.push({
      filePath,
      orm: 'harmony-rdb',
      model,
      method: m[1],
      lineNumber: lineNumberAtOffset(lineOffsets, m.index),
    });
  }

  HARMONY_RDB_INLINE_QUERY_RE.lastIndex = 0;
  while ((m = HARMONY_RDB_INLINE_QUERY_RE.exec(content)) !== null) {
    out.push({
      filePath,
      orm: 'harmony-rdb',
      model: m[2],
      method: m[1],
      lineNumber: lineNumberAtOffset(lineOffsets, m.index),
    });
  }

  HARMONY_RDB_SQL_RE.lastIndex = 0;
  while ((m = HARMONY_RDB_SQL_RE.exec(content)) !== null) {
    const model = extractSqlTableName(m[3]);
    if (model === null) continue;
    out.push({
      filePath,
      orm: 'harmony-rdb',
      model,
      method: m[1],
      lineNumber: lineNumberAtOffset(lineOffsets, m.index),
    });
  }

  const preferenceStores = new Set<string>();
  HARMONY_PREFERENCES_STORE_RE.lastIndex = 0;
  while ((m = HARMONY_PREFERENCES_STORE_RE.exec(content)) !== null) {
    preferenceStores.add(m[1]);
  }

  HARMONY_PREFERENCES_GET_RE.lastIndex = 0;
  while ((m = HARMONY_PREFERENCES_GET_RE.exec(content)) !== null) {
    if (!preferenceStores.has(m[1])) continue;
    out.push({
      filePath,
      orm: 'harmony-preferences',
      model: m[3],
      method: 'get',
      lineNumber: lineNumberAtOffset(lineOffsets, m.index),
    });
  }
}

function extractSqlTableName(sql: string): string | null {
  const normalized = sql.replace(/\s+/g, ' ').trim();
  const match = normalized.match(/\b(?:FROM|JOIN|UPDATE|INTO)\s+[`"\[]?([\w$.-]+)/i);
  return match?.[1]?.replace(/[\]`"].*$/, '') ?? null;
}

// ── Line offset helpers ───────────────────────────────────────────────────

/** Build an array of byte offsets where each newline occurs (O(n) once). */
function buildLineOffsets(content: string): number[] {
  const offsets: number[] = [];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i);
  }
  return offsets;
}

/**
 * Binary search for 0-based line number at a given character offset.
 *
 * Returns the number of newlines that occur before `offset` in the content,
 * which is the 0-based line number. When `offset` is beyond the last newline,
 * returns `lineOffsets.length` (i.e., the last line index).
 */
function lineNumberAtOffset(lineOffsets: readonly number[], offset: number): number {
  let lo = 0;
  let hi = lineOffsets.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (lineOffsets[mid] < offset) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}
