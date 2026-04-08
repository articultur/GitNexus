/**
 * SQL Injection Detection Rule
 *
 * Detects string concatenation used to build SQL queries — a primary
 * vector for SQL injection attacks (OWASP A03:2021).
 *
 * Identifies patterns like:
 *   - String-concatenated SQL: "SELECT ... WHERE id=" + userId
 *   - Template-literal SQL:    `SELECT ... WHERE id=${userId}`
 *   - Format-string SQL:       f"SELECT ... WHERE id={user_id}"  (Python)
 *   - String-format SQL:       fmt.Sprintf("SELECT ... WHERE id=%s", id) (Go)
 *
 * False-negative risk: parameterised queries with ORM (e.g. Prisma, Hibernate)
 * are safe — the rule only triggers on raw concatenation patterns.
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// SQL keyword patterns that indicate a SQL query is being built
const SQL_KEYWORD_PATTERN =
  /\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|WHERE|FROM\s+\w|UNION\s+(?:ALL\s+)?SELECT)\b/i;

// Concatenation in the same expression as a SQL keyword
const CONCAT_SQL_PATTERNS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // JS/TS: string + variable (e.g. "SELECT ... WHERE id=" + id)
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^'";\n]*['"][^'"]*['"]\s*\+\s*\w/i,
    languages: ['typescript', 'javascript'],
    description: 'SQL string concatenation — potential injection via + operator',
  },
  // JS/TS: template literal with expression inside SQL keyword context
  {
    pattern: /`[^`]*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^`]*\$\{[^}]+\}[^`]*`/i,
    languages: ['typescript', 'javascript'],
    description: 'SQL template literal — potential injection via ${expr}',
  },
  // Python: f-string or % format with SQL
  {
    pattern: /f(?:"|'){0,1}[^"']*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"']*\{[^}]+\}/i,
    languages: ['python'],
    description: 'SQL f-string interpolation — potential injection',
  },
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"'\n]*%\s*(?:\(?\w|\[)/i,
    languages: ['python'],
    description: 'SQL %-format string — potential injection',
  },
  // Go: fmt.Sprintf with SQL (double-quoted strings; single-quotes may appear inside)
  {
    pattern: /Sprintf\s*\(\s*"[^"]*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"]*%[sdvf]/i,
    languages: ['go'],
    description: 'SQL fmt.Sprintf — potential injection via %s/%d format verb',
  },
  // Java/Kotlin: string concatenation in SQL context
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"'\n]*"\s*\+\s*\w/i,
    languages: ['java', 'kotlin'],
    description: 'SQL string concatenation — potential injection via + operator',
  },
  // PHP: string interpolation in SQL context
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"'\n]*"\s*\.?\s*\$\w/i,
    languages: ['php'],
    description: 'SQL string interpolation — potential injection via $var',
  },
  // Ruby: string interpolation in SQL context
  {
    pattern: /"[^"]*(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"]*#\{[^}]+\}"/i,
    languages: ['ruby'],
    description: 'SQL string interpolation — potential injection via #{expr}',
  },
  // C#: string concatenation in SQL context
  {
    pattern: /(?:SELECT|INSERT|UPDATE|DELETE|WHERE|FROM)[^"'\n]*"\s*\+\s*\w/i,
    languages: ['csharp'],
    description: 'SQL string concatenation — potential injection via + operator',
  },
];

// Patterns indicating safe parameterised SQL (reduce false positives)
const SAFE_PATTERNS: RegExp[] = [
  /\$\d+/, // PostgreSQL-style parameterised: $1, $2
  /\?\s*[,)]/, // JDBC/MySQL-style: ?, ?
  /:\w+\b/, // Named params: :name, :id
  /@\w+\b/, // .NET/SQL Server: @param
  /\bprepare\b|\bprepareStatement\b|\bpreparedStatement\b/i, // Prepared statement calls
  /\bparameteriz/i, // parameterized/parameterised
];

/**
 * Check whether a suspicious SQL fragment is from a parameterised statement.
 */
function hasParameterisedQuery(content: string, matchIndex: number): boolean {
  // Look at ±200 chars around the match
  const start = Math.max(0, matchIndex - 200);
  const end = Math.min(content.length, matchIndex + 200);
  const window = content.slice(start, end);
  return SAFE_PATTERNS.some((p) => p.test(window));
}

export const sqlInjectionRule: Rule = {
  definition: {
    id: 'detection:sql-injection',
    name: 'SQL Injection risk',
    description:
      'Detects SQL queries built by string concatenation or interpolation without ' +
      'parameterisation — a primary SQL injection vector (OWASP A03:2021).',
    severity: 'critical',
    confidence: 0.75,
    languages: [
      'typescript',
      'javascript',
      'python',
      'java',
      'kotlin',
      'go',
      'php',
      'ruby',
      'csharp',
    ],
    trigger: {
      propertyConditions: [{ property: 'content', operator: 'not_contains', value: '""' }],
    },
    missing: {},
  },

  evaluate(ctx: RuleContext): DetectionResult | null {
    const content = ctx.node.properties.content as string | undefined;
    if (!content || content.length < 10) return null;

    // Quick pre-check: does the content even mention SQL keywords?
    if (!SQL_KEYWORD_PATTERN.test(content)) return null;

    const language = ctx.language;
    const findings: Array<{ match: RegExpMatchArray; description: string }> = [];

    for (const pat of CONCAT_SQL_PATTERNS) {
      if (pat.languages.length > 0 && !pat.languages.includes(language)) continue;

      const re = new RegExp(pat.pattern.source, 'gi');
      let match: RegExpMatchArray | null;
      while ((match = re.exec(content)) !== null) {
        if (!hasParameterisedQuery(content, match.index!)) {
          findings.push({ match, description: pat.description });
        }
        if (findings.length >= 5) break;
      }
      if (findings.length >= 5) break;
    }

    if (findings.length === 0) return null;

    const filePath = (ctx.node.properties.filePath as string) ?? '';
    const name = (ctx.node.properties.name as string) ?? '';

    const evidence: Evidence[] = findings.slice(0, 3).map((f) => ({
      description: f.description,
      symbolId: ctx.node.id,
      symbolName: name,
      filePath,
      relatedSymbols: [],
    }));

    return {
      ruleId: 'detection:sql-injection',
      message: `${name}: ${findings.length} SQL concatenation pattern(s) detected — possible injection point`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'critical',
      confidence: Math.min(0.9, 0.65 + findings.length * 0.05),
      evidence,
    };
  },
};
