/**
 * Detection rules tests — runs via `node --import tsx` to avoid vitest fork OOM.
 *
 * The vitest global-setup loads LadybugDB's native addon in the parent process,
 * which causes OOM when fork workers also import rule modules with regex-heavy
 * content. This file uses Node's built-in test runner instead.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { missingGuardRule } from '../../../src/core/detection/rules/missing-guard.js';
import { missingUnwrapRule } from '../../../src/core/detection/rules/missing-unwrap.js';
import { missingResourceRule } from '../../../src/core/detection/rules/missing-resource.js';
import { builtinRules } from '../../../src/core/detection/rules/index.js';
import type { RuleContext } from '../../../src/core/detection/types.js';

function makeCtx(
  content: string,
  language: string,
  name = 'testFn',
  filePath = 'test.ts',
): RuleContext {
  return {
    node: { id: 'fn:1', label: 'Function' as any, properties: { content, name, filePath } },
    outgoingRelationships: [],
    incomingRelationships: [],
    outgoingTargets: new Map(),
    language,
  };
}

// ── Missing Guard ───────────────────────────────────────────────────────────

describe('missing-guard rule', () => {
  it('has correct id', () => {
    assert.equal(missingGuardRule.definition.id, 'detection:missing-guard');
  });

  it('detects unguarded fetch call', () => {
    const ctx = makeCtx(
      `async function loadData() {
        const response = fetch('/api/data');
        return response.json();
      }`,
      'typescript',
    );
    const r = missingGuardRule.evaluate(ctx);
    assert.ok(r);
    assert.equal(r.ruleId, 'detection:missing-guard');
  });

  it('detects unguarded JSON.parse', () => {
    const r = missingGuardRule.evaluate(
      makeCtx(
        `function parseConfig(str) { const config = JSON.parse(str); return config; }`,
        'typescript',
      ),
    );
    assert.ok(r);
  });

  it('detects unguarded readFile', () => {
    const r = missingGuardRule.evaluate(
      makeCtx(
        `function loadFile() { const data = readFileSync('/etc/config'); return data; }`,
        'javascript',
      ),
    );
    assert.ok(r);
  });

  it('does not flag guarded code with try/catch', () => {
    const r = missingGuardRule.evaluate(
      makeCtx(
        `async function loadData() {
        try { const response = await fetch('/api/data'); return response.json(); }
        catch (e) { console.error(e); }
      }`,
        'typescript',
      ),
    );
    assert.equal(r, null);
  });

  it('does not flag empty content', () => {
    assert.equal(missingGuardRule.evaluate(makeCtx('', 'typescript')), null);
  });

  it('does not flag unrelated code', () => {
    assert.equal(
      missingGuardRule.evaluate(makeCtx('function add(a, b) { return a + b; }', 'typescript')),
      null,
    );
  });
});

// ── Missing Unwrap ──────────────────────────────────────────────────────────

describe('missing-unwrap rule', () => {
  it('has correct id', () => {
    assert.equal(missingUnwrapRule.definition.id, 'detection:missing-unwrap');
  });

  it('detects Rust .unwrap() without prior check', () => {
    const r = missingUnwrapRule.evaluate(
      makeCtx(
        `fn get_value(opt: Option<i32>) -> i32 { opt.unwrap() }`,
        'rust',
        'get_value',
        'test.rs',
      ),
    );
    assert.ok(r);
    assert.equal(r!.severity, 'high');
  });

  it('detects multiple .unwrap() calls', () => {
    const r = missingUnwrapRule.evaluate(
      makeCtx(
        `fn process(a: Option<i32>, b: Result<i32, Error>) -> i32 { let x = a.unwrap(); let y = b.unwrap(); x + y }`,
        'rust',
        'process',
        'test.rs',
      ),
    );
    assert.ok(r);
    assert.equal(r!.ruleId, 'detection:missing-unwrap');
    assert.equal(r!.severity, 'high');
  });

  it('detects TS .find() without null check', () => {
    const r = missingUnwrapRule.evaluate(
      makeCtx(
        `function getUser(users, id) { const user = users.find(u => u.id === id); return user.name; }`,
        'typescript',
      ),
    );
    assert.ok(r);
  });

  it('does not flag Rust with is_some check', () => {
    const r = missingUnwrapRule.evaluate(
      makeCtx(
        `fn get_value(opt: Option<i32>) -> i32 { if opt.is_some() { opt.unwrap() } else { 0 } }`,
        'rust',
        'get_value',
        'test.rs',
      ),
    );
    assert.equal(r, null);
  });

  it('does not flag Rust with match', () => {
    const r = missingUnwrapRule.evaluate(
      makeCtx(
        `fn get_value(opt: Option<i32>) -> i32 { match opt { Some(v) => v, None => 0 } }`,
        'rust',
        'get_value',
        'test.rs',
      ),
    );
    assert.equal(r, null);
  });

  it('returns null for empty content', () => {
    assert.equal(missingUnwrapRule.evaluate(makeCtx('', 'rust')), null);
  });
});

// ── Missing Resource Release ────────────────────────────────────────────────

describe('missing-resource rule', () => {
  it('has correct id', () => {
    assert.equal(missingResourceRule.definition.id, 'detection:missing-resource');
  });

  it('detects Python open() without with-statement', () => {
    const r = missingResourceRule.evaluate(
      makeCtx(
        `def read_config():\n    f = open('config.txt')\n    data = f.read()\n    return data`,
        'python',
        'read_config',
        'test.py',
      ),
    );
    assert.ok(r);
    assert.equal(r!.severity, 'high');
  });

  it('detects Go os.Open without defer Close', () => {
    const r = missingResourceRule.evaluate(
      makeCtx(
        `func readFile(path string) { f, err := os.Open(path); data := make([]byte, 1024); f.Read(data) }`,
        'go',
        'readFile',
        'test.go',
      ),
    );
    assert.ok(r);
  });

  it('detects JS createReadStream without close', () => {
    const r = missingResourceRule.evaluate(
      makeCtx(
        `function processFile(path) { const stream = createReadStream(path); return buffer; }`,
        'javascript',
      ),
    );
    assert.ok(r);
  });

  it('does not flag Python with-statement', () => {
    const r = missingResourceRule.evaluate(
      makeCtx(
        `def read_config():\n    with open('config.txt') as f:\n        data = f.read()\n    return data`,
        'python',
        'read_config',
        'test.py',
      ),
    );
    assert.equal(r, null);
  });

  it('does not flag Go with defer Close', () => {
    const r = missingResourceRule.evaluate(
      makeCtx(
        `func readFile(path string) error { f, err := os.Open(path); defer f.Close(); return nil }`,
        'go',
        'readFile',
        'test.go',
      ),
    );
    assert.equal(r, null);
  });

  it('does not flag JS with close()', () => {
    const r = missingResourceRule.evaluate(
      makeCtx(
        `function processFile(path) { const stream = createReadStream(path); stream.on('end', () => stream.close()); }`,
        'javascript',
      ),
    );
    assert.equal(r, null);
  });

  it('returns null for empty content', () => {
    assert.equal(missingResourceRule.evaluate(makeCtx('', 'python')), null);
  });
});

// ── Builtin rules registry ──────────────────────────────────────────────────

describe('builtin rules', () => {
  it('exports 9 rules with correct IDs', () => {
    assert.equal(builtinRules.length, 9);
    const ids = builtinRules.map((r) => r.definition.id);
    assert.ok(ids.includes('detection:missing-guard'));
    assert.ok(ids.includes('detection:missing-unwrap'));
    assert.ok(ids.includes('detection:missing-resource'));
    assert.ok(ids.includes('detection:missing-exception-handling'));
    assert.ok(ids.includes('detection:missing-return-check'));
    assert.ok(ids.includes('detection:missing-concurrency-guard'));
    assert.ok(ids.includes('detection:sql-injection'));
    assert.ok(ids.includes('detection:path-traversal'));
    assert.ok(ids.includes('detection:xss'));
  });

  it('all rules have evaluate functions', () => {
    for (const rule of builtinRules) {
      assert.equal(typeof rule.evaluate, 'function');
    }
  });

  it('all rules have valid severity and confidence', () => {
    const validSeverities = ['critical', 'high', 'medium', 'low'];
    for (const rule of builtinRules) {
      assert.ok(validSeverities.includes(rule.definition.severity));
      assert.ok(rule.definition.confidence > 0);
      assert.ok(rule.definition.confidence <= 1);
    }
  });
});
