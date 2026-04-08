/**
 * Missing Unwrap/Null-Check Detection Rule
 *
 * Detects use of Optional/Result/Nullable return values without
 * null/undefined/error checks before accessing the value.
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// Patterns that return nullable/optional values
const OPTIONAL_RETURN_PATTERNS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  {
    pattern:
      /\b(?:Map|WeakMap|WeakSet)\.prototype\.get|array\.find|\.find\(|\.at\(|\.pop\(|\.shift\(/i,
    languages: ['typescript', 'javascript'],
    description: 'nullable return value used without null check',
  },
  {
    pattern: /\.unwrap\(\)|\.expect\(/,
    languages: ['rust'],
    description: 'Result/Option unwrapped without prior check',
  },
  {
    pattern: /\w+!/,
    languages: ['swift'],
    description: 'Swift force-unwrap (!) without prior nil check',
  },
  {
    pattern: /\w+!/,
    languages: ['dart'],
    description: 'Dart null assertion (!) without prior null check',
  },
  {
    pattern: /\w+!/,
    languages: ['arkts'],
    description: 'ArkTS non-null assertion (!) without prior null check',
  },
  {
    pattern: /\.get\(\)/,
    languages: ['java', 'kotlin'],
    description: 'Optional.get() without isPresent check',
  },
  {
    pattern: /\w+\s*,\s*(?:_\s*)?[\w.]+\s*\(.*\)/,
    languages: ['go'],
    description: 'function call with error return ignored',
  },
];

// Patterns that indicate a proper check IS present
const CHECK_PATTERNS: RegExp[] = [
  /\bif\s*\([^)]*(?:!=?\s*(?:null|undefined|nil|None)|===?\s*(?:null|undefined|nil|None)|!\s*\w|\.isPresent|\.isSome|\.isOk|\.ok\b)/,
  /\.is_some\b|\.is_ok\b|\.is_err\b|\.is_none\b/,
  /\bif\s+\w+\s*(?::\s*\w+\?)?\s*=\s*/,
  /\bswitch\s*\([^)]*\)\s*\{[^}]*case\s+(?:null|undefined|nil|None|\.none)/,
  /\?\?|\?\.\w|!\s*=|\.orElse|\.orElseGet|\.orElseThrow|\.unwrap_or/,
  /\bguard\b.*\b(?:let|var)\b/,
  /if let|if case|case \./,
];

export const missingUnwrapRule: Rule = {
  definition: {
    id: 'detection:missing-unwrap',
    name: 'Missing null/unwrap check',
    description:
      'Detects use of Optional/Result/Nullable return values without ' +
      'null/undefined/error checks (e.g., .unwrap(), Optional.get(), ignoring error returns).',
    severity: 'high',
    confidence: 0.75,
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

    for (const optPattern of OPTIONAL_RETURN_PATTERNS) {
      if (optPattern.languages.length > 0 && !optPattern.languages.includes(language)) continue;

      const re = new RegExp(optPattern.pattern.source, optPattern.pattern.flags);
      const matches = content.match(re);
      if (matches && !CHECK_PATTERNS.some((p) => p.test(content))) {
        findings.push(optPattern.description);
      }
    }

    // Language-specific: Rust .unwrap() without .is_some() / .is_ok()
    if (language === 'rust') {
      const unwrapCount = (content.match(/\.unwrap\(\)/g) || []).length;
      const hasCheck =
        /\b(?:is_some|is_ok|if let|match|\.map\(|and_then|\.unwrap_or|\.unwrap_or_else)\b/.test(
          content,
        );
      if (unwrapCount > 0 && !hasCheck) {
        findings.push(`Rust: ${unwrapCount} .unwrap() call(s) without prior check`);
      }
    }

    // Language-specific: TS/JS - array.find / Map.get without null check
    if (language === 'typescript' || language === 'javascript') {
      const riskyAccess = content.match(/\.find\([^)]*\)/g);
      const hasNullCheck = /\b(?:if\s*\(.*null|if\s*\(.*undefined|\?\.\w|\?\?|\!\s*=)/.test(
        content,
      );
      if (riskyAccess && riskyAccess.length > 0 && !hasNullCheck) {
        findings.push('TS/JS: .find() result used without null/undefined check');
      }
    }

    if (findings.length === 0) return null;

    const filePath = (ctx.node.properties.filePath as string) ?? '';
    const name = (ctx.node.properties.name as string) ?? '';

    const evidence: Evidence[] = findings.map((desc) => ({
      description: desc,
      symbolId: ctx.node.id,
      symbolName: name,
      filePath,
      relatedSymbols: [],
    }));

    return {
      ruleId: 'detection:missing-unwrap',
      message: `${name}: ${findings[0]}`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'high',
      confidence: 0.75,
      evidence,
    };
  },
};
