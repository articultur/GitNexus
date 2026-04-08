/**
 * Detect changes tool — git-diff based impact analysis.
 */

import { executeParameterized } from '../../../core/lbug/pool-adapter.js';
import { logQueryError } from './shared.js';
import type { RepoHandle } from './shared.js';

/**
 * Detect changes — git-diff based impact analysis.
 * Maps changed lines to indexed symbols, then finds affected processes.
 */
export async function detectChangesTool(
  repo: RepoHandle,
  params: {
    scope?: string;
    base_ref?: string;
    /** When false, omit the `evidence` block from the response. Default: true */
    include_evidence?: boolean;
    /** When true, run bug detection rules on changed symbols. Default: false */
    enable_detection?: boolean;
  },
  ensureInitialized: (id: string) => Promise<void>,
): Promise<any> {
  await ensureInitialized(repo.id);

  const scope = params.scope || 'unstaged';
  const include_evidence = params.include_evidence ?? true;
  const { execFileSync } = await import('child_process');

  // Build git diff args based on scope (using execFileSync to avoid shell injection)
  let diffArgs: string[];
  switch (scope) {
    case 'staged':
      diffArgs = ['diff', '--staged', '--name-only'];
      break;
    case 'all':
      diffArgs = ['diff', 'HEAD', '--name-only'];
      break;
    case 'compare':
      if (!params.base_ref) return { error: 'base_ref is required for "compare" scope' };
      diffArgs = ['diff', params.base_ref, '--name-only'];
      break;
    case 'unstaged':
    default:
      diffArgs = ['diff', '--name-only'];
      break;
  }

  let changedFiles: string[];
  try {
    const output = execFileSync('git', diffArgs, { cwd: repo.repoPath, encoding: 'utf-8' });
    changedFiles = output
      .trim()
      .split('\n')
      .filter((f) => f.length > 0);
  } catch (err: any) {
    return { error: `Git diff failed: ${err.message}` };
  }

  if (changedFiles.length === 0) {
    return {
      summary: {
        changed_count: 0,
        affected_count: 0,
        risk_level: 'none',
        message: 'No changes detected.',
      },
      changed_symbols: [],
      affected_processes: [],
    };
  }

  // Map changed files to indexed symbols
  const changedSymbols: any[] = [];
  const fileMatches: Array<{ filePath: string; symbols: any[] }> = [];
  for (const file of changedFiles) {
    const normalizedFile = file.replace(/\\/g, '/');
    try {
      const symbols = await executeParameterized(
        repo.id,
        `
          MATCH (n) WHERE n.filePath CONTAINS $filePath
          RETURN n.id AS id, n.name AS name, labels(n)[0] AS type, n.filePath AS filePath
          LIMIT 20
        `,
        { filePath: normalizedFile },
      );
      const fileSymbols = symbols.map((sym: any) => ({
        id: sym.id || sym[0],
        name: sym.name || sym[1],
        type: sym.type || sym[2],
        filePath: sym.filePath || sym[3],
        match_reason: `filePath contains ${normalizedFile}`,
      }));
      fileMatches.push({ filePath: normalizedFile, symbols: fileSymbols });
      for (const sym of symbols) {
        changedSymbols.push({
          id: sym.id || sym[0],
          name: sym.name || sym[1],
          type: sym.type || sym[2],
          filePath: sym.filePath || sym[3],
          change_type: 'Modified',
          match_reason: `filePath contains ${normalizedFile}`,
        });
      }
    } catch (e) {
      logQueryError('detect-changes:file-symbols', e);
    }
  }

  // Find affected processes
  const affectedProcesses = new Map<string, any>();
  for (const sym of changedSymbols) {
    try {
      const procs = await executeParameterized(
        repo.id,
        `
          MATCH (n {id: $nodeId})-[r:CodeRelation {type: 'STEP_IN_PROCESS'}]->(p:Process)
          RETURN p.id AS pid, p.heuristicLabel AS label, p.processType AS processType, p.stepCount AS stepCount, r.step AS step
        `,
        { nodeId: sym.id },
      );
      for (const proc of procs) {
        const pid = proc.pid || proc[0];
        if (!affectedProcesses.has(pid)) {
          affectedProcesses.set(pid, {
            id: pid,
            name: proc.label || proc[1],
            process_type: proc.processType || proc[2],
            step_count: proc.stepCount || proc[3],
            changed_steps: [],
          });
        }
        affectedProcesses.get(pid)!.changed_steps.push({
          symbol: sym.name,
          step: proc.step || proc[4],
        });
      }
    } catch (e) {
      logQueryError('detect-changes:process-lookup', e);
    }
  }

  const processCount = affectedProcesses.size;
  const risk =
    processCount === 0
      ? 'low'
      : processCount <= 5
        ? 'medium'
        : processCount <= 15
          ? 'high'
          : 'critical';

  // ── Bug detection on changed symbols ────────────────────────────────
  let detection_findings: any[] | undefined;
  if (params.enable_detection && changedSymbols.length > 0) {
    try {
      const { RuleEngine } = await import('../../../core/detection/rule-engine.js');
      const { builtinRules } = await import('../../../core/detection/rules/index.js');
      const engine = new RuleEngine();
      for (const rule of builtinRules) engine.register(rule);

      const findings: any[] = [];
      for (const sym of changedSymbols) {
        // Fetch full node content for rule evaluation
        const rows = await executeParameterized(
          repo.id,
          `MATCH (n {id: $nodeId}) RETURN n.id AS id, n.name AS name, labels(n)[0] AS label, n.filePath AS filePath, n.content AS content LIMIT 1`,
          { nodeId: sym.id },
        );
        if (!rows?.[0]?.content) continue;

        const row = rows[0];
        const ctx = {
          node: {
            id: row.id || row[0],
            label: (row.label || row[2]) as any,
            properties: {
              name: row.name || row[1],
              filePath: row.filePath || row[3],
              content: row.content || row[4],
            },
          },
          outgoingRelationships: [],
          incomingRelationships: [],
          outgoingTargets: new Map(),
          language: (row.filePath || row[3] || '').split('.').pop()?.toLowerCase() ?? '',
        };
        const results = engine.evaluateNode(ctx);
        findings.push(...results);
      }
      detection_findings = findings;
    } catch (e) {
      // Detection is best-effort — don't fail the whole detect_changes
      logQueryError('detect-changes:detection', e);
    }
  }

  return {
    summary: {
      changed_count: changedSymbols.length,
      affected_count: processCount,
      changed_files: changedFiles.length,
      risk_level: risk,
      ...(detection_findings && { detection_count: detection_findings.length }),
    },
    changed_symbols: changedSymbols,
    affected_processes: Array.from(affectedProcesses.values()),
    ...(detection_findings && detection_findings.length > 0 && { detection_findings }),
    ...(include_evidence && {
      evidence: {
        explanation:
          'Changed files are matched to indexed symbols by file path, then expanded to processes through STEP_IN_PROCESS links.',
        changed_files: changedFiles,
        file_matches: fileMatches,
        process_matches: Array.from(affectedProcesses.values()),
      },
    }),
  };
}
