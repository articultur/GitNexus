/**
 * LadybugDB Schema Version Utilities
 *
 * Provides a deterministic schema fingerprint so the ingestion pipeline can
 * detect whether an existing .gitnexus database was built with a different
 * schema than the current one.
 *
 * Strategy
 * ────────
 * 1. Compute a short SHA-256 hex hash over all SCHEMA_QUERIES joined in order.
 * 2. Store the hash in meta.json as `schemaVersion` after every full index.
 * 3. On startup, compare the stored version with the current one:
 *    - Same hash      → schema is compatible, open normally.
 *    - Different hash → attempt incremental migration (additive changes only).
 *                       If migration is unsafe, caller must clean + rebuild.
 *
 * Migration policy (additive vs. breaking)
 * ─────────────────────────────────────────
 * LadybugDB cannot drop columns or change column types in an existing table.
 * Therefore:
 *   • New tables / new FROM-TO pairs   → additive → apply in-place.
 *   • Changed column types / dropped columns → breaking → require rebuild.
 *
 * The migration code attempts to run each schema query and silently ignores
 * "already exists" errors. Any other error is treated as a breaking change
 * and the caller receives `MigrationResult.needsRebuild = true`.
 */

import { createHash } from 'crypto';
import { SCHEMA_QUERIES } from './schema.js';

// ─── Version computation ──────────────────────────────────────────────────

/**
 * Compute a 12-character hex fingerprint of the current schema.
 * The fingerprint changes whenever any schema query changes, new tables are
 * added, or existing table definitions are modified.
 */
export function computeSchemaVersion(): string {
  const combined = SCHEMA_QUERIES.join('\n');
  return createHash('sha256').update(combined).digest('hex').slice(0, 12);
}

/** The schema version expected by the current codebase. */
export const CURRENT_SCHEMA_VERSION: string = computeSchemaVersion();

// ─── Migration result ─────────────────────────────────────────────────────

export interface MigrationResult {
  /** Whether the DB is ready to use (either already matching or migrated). */
  ok: boolean;
  /**
   * True when the schema change requires a full clean + rebuild.
   * The caller should wipe the DB, re-run indexing, then write the new version.
   */
  needsRebuild: boolean;
  /** Human-readable description of what was done. */
  message: string;
  /** Schema version found in the stored meta (empty string = not present). */
  storedVersion: string;
  /** Schema version expected by the current code. */
  currentVersion: string;
}

/**
 * Build actionable rebuild instructions for schema-breaking migrations.
 *
 * `gitnexus clean` operates on the current working directory, so the safest
 * guidance is an explicit `cd` into the indexed repository followed by a
 * forced clean and re-analyze.
 */
export function formatSchemaRebuildInstructions(repoPath: string): string {
  const escapedRepoPath = repoPath.replace(/(["\\`$])/g, '\\$1');
  return [
    'Rebuild the index from the repository root:',
    `  cd "${escapedRepoPath}"`,
    '  gitnexus clean --force',
    '  gitnexus analyze',
  ].join('\n');
}

// ─── In-place migration ───────────────────────────────────────────────────

/**
 * Attempt an in-place schema migration on an already-open LadybugDB connection.
 *
 * Runs all SCHEMA_QUERIES and ignores "already exists" errors — this is safe
 * for purely additive changes (new tables, new FROM-TO pairs in a REL table).
 * If any query fails for a reason other than "already exists", the migration
 * is treated as a breaking change and `needsRebuild` is set to true.
 *
 * @param conn   An open LadybugDB `Connection` instance.
 * @param stored The schema version stored in the existing meta.json.
 */
export async function attemptIncrementalMigration(
  conn: { query: (sql: string) => Promise<unknown> },
  stored: string,
): Promise<MigrationResult> {
  const current = CURRENT_SCHEMA_VERSION;

  if (stored === current) {
    return {
      ok: true,
      needsRebuild: false,
      message: 'Schema is up-to-date.',
      storedVersion: stored,
      currentVersion: current,
    };
  }

  const applied: string[] = [];
  const failed: string[] = [];

  for (const query of SCHEMA_QUERIES) {
    try {
      await conn.query(query);
      // Extract a short label for logging (first non-whitespace word after CREATE)
      const label = query.trim().split(/\s+/).slice(0, 4).join(' ');
      applied.push(label);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('already exists')) {
        // Existing table/column — safe to skip
        continue;
      }
      // Unexpected error → potentially breaking change
      const label = query.trim().split(/\s+/).slice(0, 4).join(' ');
      failed.push(`${label}: ${msg.slice(0, 80)}`);
    }
  }

  if (failed.length > 0) {
    return {
      ok: false,
      needsRebuild: true,
      message:
        `Schema migration failed for ${failed.length} quer${failed.length === 1 ? 'y' : 'ies'} ` +
        `(likely breaking changes). Full rebuild required.\n` +
        failed.map((f) => `  • ${f}`).join('\n'),
      storedVersion: stored,
      currentVersion: current,
    };
  }

  const addedCount = applied.length;
  return {
    ok: true,
    needsRebuild: false,
    message:
      addedCount > 0
        ? `Incremental migration applied ${addedCount} new schema object${addedCount === 1 ? '' : 's'}.`
        : 'Schema queries ran without changes (additive migration already complete).',
    storedVersion: stored,
    currentVersion: current,
  };
}
