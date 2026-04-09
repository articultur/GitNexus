/**
 * Unit tests for LadybugDB schema version utilities
 *
 * Covers:
 * 1. computeSchemaVersion() returns consistent 12-char hex fingerprint
 * 2. CURRENT_SCHEMA_VERSION is deterministic across calls
 * 3. attemptIncrementalMigration() — schema already matches → ok, no rebuild
 * 4. attemptIncrementalMigration() — new tables added → ok, no rebuild
 * 5. attemptIncrementalMigration() — breaking query → needsRebuild
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeSchemaVersion,
  CURRENT_SCHEMA_VERSION,
  attemptIncrementalMigration,
  formatSchemaRebuildInstructions,
} from '../../../src/core/lbug/schema-version.js';

// ── Helpers ───────────────────────────────────────────────────────────────

/** Build a stub LadybugDB connection with configurable query behaviour. */
function makeConn(behaviour: 'alwaysOk' | 'alwaysExists' | 'breakingError') {
  return {
    query: vi.fn().mockImplementation(async (sql: string) => {
      if (behaviour === 'alwaysOk') return [];
      if (behaviour === 'alwaysExists') {
        throw new Error('table already exists');
      }
      if (behaviour === 'breakingError') {
        // Simulate a breaking schema error on the first query only
        const first = (makeConn as any).__callCount === undefined;
        if (first) {
          throw new Error('Column type mismatch: cannot alter existing table');
        }
        return [];
      }
    }),
  };
}

function makeBreakingConn() {
  return {
    query: vi.fn().mockRejectedValue(new Error('Column type mismatch: cannot change column')),
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe('computeSchemaVersion', () => {
  it('returns a 12-character hex string', () => {
    const v = computeSchemaVersion();
    expect(v).toHaveLength(12);
    expect(/^[0-9a-f]{12}$/.test(v)).toBe(true);
  });

  it('is stable across multiple calls', () => {
    expect(computeSchemaVersion()).toBe(computeSchemaVersion());
  });

  it('matches CURRENT_SCHEMA_VERSION', () => {
    expect(computeSchemaVersion()).toBe(CURRENT_SCHEMA_VERSION);
  });
});

describe('attemptIncrementalMigration — already up-to-date', () => {
  it('returns ok=true, needsRebuild=false when versions match', async () => {
    const conn = { query: vi.fn() };
    const result = await attemptIncrementalMigration(conn, CURRENT_SCHEMA_VERSION);

    expect(result.ok).toBe(true);
    expect(result.needsRebuild).toBe(false);
    expect(result.message).toMatch(/up-to-date/i);
    // Should not have run any queries
    expect(conn.query).not.toHaveBeenCalled();
  });
});

describe('attemptIncrementalMigration — additive new tables', () => {
  it('returns ok=true when all queries succeed or already exist', async () => {
    // All queries throw "already exists" — simulates DB that already has all tables
    const conn = {
      query: vi.fn().mockRejectedValue(new Error('table already exists')),
    };

    const result = await attemptIncrementalMigration(conn, 'old_version_abc');

    expect(result.ok).toBe(true);
    expect(result.needsRebuild).toBe(false);
    expect(result.storedVersion).toBe('old_version_abc');
    expect(result.currentVersion).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('returns ok=true and reports applied count when new tables succeed', async () => {
    const conn = {
      query: vi.fn().mockResolvedValue([]), // all succeed (fresh new tables)
    };

    const result = await attemptIncrementalMigration(conn, 'old_version_xyz');

    expect(result.ok).toBe(true);
    expect(result.needsRebuild).toBe(false);
    expect(result.message).toMatch(/migrated|applied|Incremental/i);
  });
});

describe('attemptIncrementalMigration — breaking change', () => {
  it('returns needsRebuild=true when a query fails with a non-exists error', async () => {
    const conn = makeBreakingConn();
    const result = await attemptIncrementalMigration(conn, 'old_version_123');

    expect(result.ok).toBe(false);
    expect(result.needsRebuild).toBe(true);
    expect(result.message).toMatch(/rebuild/i);
  });
});

describe('formatSchemaRebuildInstructions', () => {
  it('returns explicit clean and analyze commands for the repo root', () => {
    const instructions = formatSchemaRebuildInstructions('/tmp/my repo');
    expect(instructions).toContain('cd "/tmp/my repo"');
    expect(instructions).toContain('gitnexus clean --force');
    expect(instructions).toContain('gitnexus analyze');
  });
});
