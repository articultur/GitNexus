/**
 * Missing Concurrency Guard Detection Rule
 *
 * Detects shared mutable state accessed without synchronization
 * (mutex, lock, synchronized, atomic operations).
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// Patterns indicating shared mutable state access
const MUTABLE_ACCESS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // Shared variable mutation in async/callback context
  {
    pattern: /(?:let|var)\s+\w+\s*=.*(?:async\s+function|setTimeout|setInterval|Promise|\.then)/,
    languages: ['typescript', 'javascript'],
    description: 'mutable variable in async context without lock',
  },
  // .push/.splice/.shift on shared array in async
  {
    pattern: /\.(?:push|splice|shift|unshift|pop|sort|reverse)\([^)]*\)/,
    languages: ['typescript', 'javascript', 'python'],
    description: 'shared array mutation without synchronization',
  },
  // ++/-- on shared counter
  {
    pattern: /\w+\+\+|\w+--|\+\+\w+|--\w+/,
    languages: ['typescript', 'javascript', 'java', 'cpp', 'c', 'csharp'],
    description: 'shared counter increment/decrement without atomic',
  },
  // Python: mutable global/class variable in thread context
  {
    pattern: /(?:global|self)\.\w+\s*=(?![^]*\b(?:Lock|RLock|Semaphore|with\s))/,
    languages: ['python'],
    description: 'mutable state in Python without Lock',
  },
  // Swift: shared mutable state accessed without DispatchQueue/NSLock/actor
  {
    pattern: /\bvar\s+\w+\s*=.*(?:DispatchQueue|DispatchGroup|NotificationCenter|Thread)/,
    languages: ['swift'],
    description: 'shared mutable state in Swift without DispatchQueue barrier or actor',
  },
  // Dart: shared mutable state accessed without Isolate-level protection
  {
    pattern: /\bvar\s+\w+\s*=.*(?:Isolate\.spawn|compute\(|Future\.wait|Stream\.fromFutures)/,
    languages: ['dart'],
    description: 'shared mutable state in Dart async/Isolate context',
  },
];

// Patterns indicating synchronization IS present
const SYNC_PATTERNS: RegExp[] = [
  /\bmutex\b/i,
  /\block\b/i,
  /\bLock\b/,
  /\bsynchronized\b/,
  /\bAtomic(?:Integer|Boolean|Reference|Long)/,
  /\batomic_/,
  /\b__sync_/,
  /\b__atomic_/,
  /\bwith\s+\w*(?:lock|mutex|Lock)/,
  /\bReentrantLock\b/,
  /\bSemaphore\b/,
  /\bRwLock\b/,
  /\bstd::mutex\b/,
  /\bstd::atomic\b/,
  /\bCriticalSection\b/,
  /\bMonitor\b/,
  /\bvolatile\b/,
  // Swift synchronization primitives
  /\bDispatchQueue\b/,
  /\bNSLock\b/,
  /\bNSRecursiveLock\b/,
  /\bOSAllocatedUnfairLock\b/,
  /\b@MainActor\b/,
  /\bactor\s+\w/,
  // Dart: Mutex / Completer / StreamController with synchronization
  /\bMutex\b/,
  /\bReadWriteMutex\b/,
  /\bIsolate\./,
];

export const missingConcurrencyGuardRule: Rule = {
  definition: {
    id: 'detection:missing-concurrency-guard',
    name: 'Missing concurrency guard',
    description:
      'Detects shared mutable state access (array mutation, counter increment, ' +
      'variable assignment) in async/threaded contexts without synchronization.',
    severity: 'high',
    confidence: 0.6,
    languages: ['*'],
    trigger: {
      propertyConditions: [{ property: 'content', operator: 'not_contains', value: '""' }],
    },
    missing: {},
  },

  evaluate(ctx: RuleContext): DetectionResult | null {
    const content = ctx.node.properties.content as string | undefined;
    if (!content || content.length < 10) return null;

    const language = ctx.language;
    const findings: string[] = [];

    // Only flag if the code has async/threading indicators
    const hasConcurrency =
      /\b(?:async|await|Promise|setTimeout|setInterval|thread|Thread|goroutine|go\s+func|spawn|\.fork|multiprocessing|concurrent)/.test(
        content,
      );
    if (!hasConcurrency) return null;

    // If sync primitives are present, assume proper handling
    if (SYNC_PATTERNS.some((p) => p.test(content))) return null;

    for (const pat of MUTABLE_ACCESS) {
      if (pat.languages.length > 0 && !pat.languages.includes(language)) continue;

      const re = new RegExp(pat.pattern.source, pat.pattern.flags + 'g');
      const matches = content.match(re);
      if (matches && matches.length > 0) {
        findings.push(`${pat.description} (${matches.length} occurrence(s))`);
      }
    }

    if (findings.length === 0) return null;

    const filePath = (ctx.node.properties.filePath as string) ?? '';
    const name = (ctx.node.properties.name as string) ?? '';

    const evidence: Evidence[] = findings.slice(0, 5).map((desc) => ({
      description: desc,
      symbolId: ctx.node.id,
      symbolName: name,
      filePath,
      relatedSymbols: [],
    }));

    return {
      ruleId: 'detection:missing-concurrency-guard',
      message: `${name}: ${findings.length} unsynchronized mutable access(es) (${findings[0]})`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'high',
      confidence: 0.6,
      evidence,
    };
  },
};
