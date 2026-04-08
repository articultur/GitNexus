/**
 * Missing Return Check Detection Rule
 *
 * Detects function calls whose return value (error code, status, boolean)
 * is discarded without being checked.
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// Functions that return error/status codes that should be checked
const RETURN_CHECK_PATTERNS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // C/C++: functions returning int error codes
  {
    pattern: /\b\w+\s*\(.*\)\s*;/,
    languages: ['c', 'cpp'],
    description: 'C/C++ function return value ignored',
  },
  // ObjC: message send return value discarded (e.g. [obj method] without capturing result)
  // Flag alloc/init chains whose result is not assigned
  {
    pattern: /\[\s*\w+\s+(?:alloc|init\w*)\s*\]\s*;/,
    languages: ['objectivec'],
    description: 'ObjC alloc/init return value discarded — likely nil not assigned',
  },
  // NSError** out-parameter pattern: method:error: called without checking result
  {
    pattern: /\[\s*\w+\s+\w+:[^\]]*error:\s*&?\w+\s*\]\s*;/,
    languages: ['objectivec'],
    description: 'ObjC NSError** method return value discarded — error not checked',
  },
  // Go: multi-return with error ignored via _
  {
    pattern: /\w+\s*,\s*_\s*:=\s*\w+\(/,
    languages: ['go'],
    description: 'Go error return ignored with _',
  },
  // TS/JS: Promise without .then/.catch/await
  {
    pattern: /\b\w+\([^)]*\)\s*;(?!.*(?:\.then|\.catch|await|return))/,
    languages: ['typescript', 'javascript'],
    description: 'possible async call without await or .then/.catch',
  },
];

// Patterns indicating the return IS checked
const CHECKED_PATTERNS: RegExp[] = [
  /\bif\s*\(/,
  /\bassert\b/,
  /\bcheck\b/,
  /\bexpect\b/,
  /\bmust\b/,
  /\brequire\b/,
  /\bverify\b/,
  /(?:=|==|!=|>|<)/,
  /\bawait\b/,
  /\.then\s*\(/,
  /\.catch\s*\(/,
  /\breturn\b/,
  /\bthrow\b/,
];

/**
 * Lines where a function call's return is used as an expression (assigned, compared, etc.)
 * indicate the return IS being checked.
 */
function isReturnUsed(
  content: string,
  callLine: string,
  callLineIdx: number,
  language: string,
): boolean {
  // Go's := assignment uses = but doesn't mean the value is "checked"
  // Strip := before checking for = usage
  const lineToCheck = language === 'go' ? callLine.replace(/:=/g, '  ') : callLine;
  // If the line has assignment or comparison, the return is used
  if (CHECKED_PATTERNS.some((p) => p.test(lineToCheck))) return true;

  // Check next 2 lines for if/assert on the variable
  const lines = content.split('\n');
  const nextLines = lines.slice(callLineIdx + 1, callLineIdx + 3).join('\n');
  if (/\b(?:if|assert|check|expect|require)\b/.test(nextLines)) return true;

  return false;
}

export const missingReturnCheckRule: Rule = {
  definition: {
    id: 'detection:missing-return-check',
    name: 'Missing return value check',
    description:
      'Detects function calls that return error codes, status values, or Promises ' +
      'where the return value is discarded without being checked.',
    severity: 'medium',
    confidence: 0.65,
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

    for (const pat of RETURN_CHECK_PATTERNS) {
      if (pat.languages.length > 0 && !pat.languages.includes(language)) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (pat.pattern.test(line) && !isReturnUsed(content, line, i, language)) {
          findings.push(pat.description);
        }
        if (findings.length >= 10) break;
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
      ruleId: 'detection:missing-return-check',
      message: `${name}: ${findings.length} unchecked return(s) (${findings[0]})`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'medium',
      confidence: 0.65,
      evidence,
    };
  },
};
