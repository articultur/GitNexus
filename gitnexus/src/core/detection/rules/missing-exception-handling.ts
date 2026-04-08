/**
 * Missing Exception Handling Detection Rule
 *
 * Detects catch blocks that silently swallow exceptions
 * (empty catch body, catch with only comment, catch logging without re-raise).
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// Patterns that indicate the exception is properly handled (not swallowed)
const PROPER_HANDLING: RegExp[] = [
  /\bthrow\b/,
  /\braise\b/,
  /\breturn\b/,
  /\bcontinue\b/,
  /\bbreak\b/,
  /\bprocess\.exit\b/,
  /\bexit\(/,
  /\bcallback\(/,
  /\breject\(/,
  /\.emit\(/,
  /\bsend\b/,
  /\brespond\b/,
  /\breply\b/,
  /\bnext\(/,
];

/**
 * Check if a catch body has meaningful handling (not just swallowing).
 */
function isProperlyHandled(catchBody: string): boolean {
  const trimmed = catchBody.trim();
  if (trimmed.length === 0) return false;

  // Only comments
  const noComments = trimmed
    .replace(/\/\/.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim();
  if (noComments.length === 0) return false;

  return PROPER_HANDLING.some((p) => p.test(catchBody));
}

/**
 * Extract the body between matched braces starting from the opening brace at `startIdx`.
 */
function extractBracedBody(content: string, openBraceIdx: number): string | null {
  if (content[openBraceIdx] !== '{') return null;
  let depth = 0;
  let i = openBraceIdx;
  while (i < content.length) {
    if (content[i] === '{') depth++;
    else if (content[i] === '}') {
      depth--;
      if (depth === 0) {
        return content.substring(openBraceIdx + 1, i);
      }
    }
    i++;
  }
  return null;
}

/**
 * Extract catch block bodies from content.
 */
function extractCatchBlocks(content: string): Array<{ body: string; startIndex: number }> {
  const results: Array<{ body: string; startIndex: number }> = [];

  // JS/TS/Java/Kotlin/C# style: catch (e) { ... }
  const catchRe = /catch\s*\(\s*\w+\s*\)\s*\{/g;
  const catchMatches = content.matchAll(catchRe);
  for (const match of catchMatches) {
    if (match.index === undefined) continue;
    const bodyStart = match.index + match[0].length;
    const body = extractBracedBody(content, bodyStart - 1);
    if (body !== null) {
      results.push({ body, startIndex: match.index });
    }
  }

  // Python style: except Exception as e:\n  pass
  const pyExcept = /except\s+[\w.]+(?:\s+as\s+\w+)?:\s*\n(\s*(?:pass|continue|break|\.\.\.))/g;
  const pyMatches = content.matchAll(pyExcept);
  for (const match of pyMatches) {
    if (match.index === undefined) continue;
    results.push({ body: match[1] || '', startIndex: match.index });
  }

  return results;
}

export const missingExceptionHandlingRule: Rule = {
  definition: {
    id: 'detection:missing-exception-handling',
    name: 'Swallowed exception',
    description:
      'Detects catch/except blocks that silently swallow exceptions without ' +
      'proper handling (empty body, only comments, or logging without re-raise).',
    severity: 'medium',
    confidence: 0.7,
    languages: ['*'],
    trigger: {
      propertyConditions: [
        { property: 'content', operator: 'contains', value: 'catch' },
      ],
    },
    missing: {},
  },

  evaluate(ctx: RuleContext): DetectionResult | null {
    const content = ctx.node.properties.content as string | undefined;
    if (!content || content.length < 10) return null;

    const hasCatch = /\bcatch\s*\(|\bexcept\s+/.test(content);
    if (!hasCatch) return null;

    const findings: Array<{ body: string; description: string }> = [];
    const catchBlocks = extractCatchBlocks(content);

    for (const block of catchBlocks) {
      if (!isProperlyHandled(block.body)) {
        const bodyPreview = block.body.trim().substring(0, 60);
        findings.push({
          body: bodyPreview,
          description: `empty or passive catch block (body: "${bodyPreview || '(empty)'}")`,
        });
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
      ruleId: 'detection:missing-exception-handling',
      message: `${name}: ${findings.length} swallowed exception(s) (${findings[0].description})`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'medium',
      confidence: Math.min(0.9, 0.6 + findings.length * 0.1),
      evidence,
    };
  },
};
