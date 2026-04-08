/**
 * Missing Guard Detection Rule
 *
 * Detects calls to operations that can fail (file open, network, parse)
 * without surrounding if/try/catch guards.
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// Functions/patterns known to require error handling, grouped by language family
const RISKY_CALLS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // File operations
  { pattern: /\b(?:readFile|readFileSync|writeFile|writeFileSync|fopen|openSync)\b/, languages: ['typescript', 'javascript', 'python', 'go', 'c', 'cpp', 'ruby'], description: 'file I/O without error guard' },
  { pattern: /\bFile\(|FileReader|FileWriter|FileInputStream|FileOutputStream\b/, languages: ['java', 'kotlin', 'csharp'], description: 'file I/O without error guard' },
  // Network operations
  { pattern: /\b(?:fetch|axios|http\.get|https\.get|urlopen|urllib)\b/, languages: ['typescript', 'javascript', 'python', 'go'], description: 'network call without error guard' },
  // Parse operations
  { pattern: /\b(?:JSON\.parse|parseInt|parseFloat|atob|btoa)\b/, languages: ['typescript', 'javascript'], description: 'parse call without error guard' },
  // Database
  { pattern: /\b(?:query\(|findMany|findUnique|findOne|\.raw\()\b/, languages: ['typescript', 'javascript', 'python', 'java', 'kotlin'], description: 'database query without error guard' },
];

// Patterns that indicate a guard IS present
const GUARD_PATTERNS: RegExp[] = [
  /\btry\s*[({]/,
  /\bcatch\s*\(/,
  /\bif\s*\([^)]*(?:===?\s*(?:null|undefined|nil|None)|!\s*\w|\.ok\b|isErr|isError|\.error\b)/,
  /\.catch\s*\(/,
  /on\s*\(?Error/,
];

/**
 * Check if content around a risky call has a guard.
 * Looks at surrounding lines for guard patterns.
 */
function hasGuard(content: string, matchIndex: number): boolean {
  const lines = content.split('\n');
  let currentPos = 0;
  let matchedLineIdx = 0;

  for (let i = 0; i < lines.length; i++) {
    if (currentPos + lines[i].length >= matchIndex) {
      matchedLineIdx = i;
      break;
    }
    currentPos += lines[i].length + 1;
  }

  const windowStart = Math.max(0, matchedLineIdx - 5);
  const windowEnd = Math.min(lines.length, matchedLineIdx + 3);
  const window = lines.slice(windowStart, windowEnd).join('\n');

  return GUARD_PATTERNS.some((p) => p.test(window));
}

export const missingGuardRule: Rule = {
  definition: {
    id: 'detection:missing-guard',
    name: 'Missing error guard',
    description:
      'Detects calls to operations that can fail (file I/O, network, parse, DB) ' +
      'without surrounding if/try/catch error handling.',
    severity: 'medium',
    confidence: 0.7,
    languages: ['*'],
    trigger: {
      propertyConditions: [
        { property: 'content', operator: 'not_contains', value: '""' },
      ],
    },
    missing: {},
  },

  evaluate(ctx: RuleContext): DetectionResult | null {
    const content = ctx.node.properties.content as string | undefined;
    if (!content || content.length < 10) return null;

    const language = ctx.language;
    const findings: Array<{ match: RegExpMatchArray; description: string }> = [];

    for (const risky of RISKY_CALLS) {
      if (risky.languages.length > 0 && !risky.languages.includes(language)) continue;

      const re = new RegExp(risky.pattern.source, risky.pattern.flags + 'g');
      let match: RegExpMatchArray | null;
      while ((match = re.exec(content)) !== null) {
        if (!hasGuard(content, match.index)) {
          findings.push({ match, description: risky.description });
        }
        // Safety: limit matches per pattern to avoid runaway
        if (findings.length >= 10) break;
      }
    }

    if (findings.length === 0) return null;

    const filePath = (ctx.node.properties.filePath as string) ?? '';
    const name = (ctx.node.properties.name as string) ?? '';

    const evidence: Evidence[] = findings.slice(0, 5).map((f) => ({
      description: f.description,
      symbolId: ctx.node.id,
      symbolName: name,
      filePath,
      relatedSymbols: [],
    }));

    return {
      ruleId: 'detection:missing-guard',
      message: `${name}: ${findings.length} unguarded call(s) that can fail (${findings[0].description})`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'medium',
      confidence: Math.min(0.9, 0.5 + findings.length * 0.1),
      evidence,
    };
  },
};
