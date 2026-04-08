/**
 * Missing Resource Release Detection Rule
 *
 * Detects resources (files, connections, streams) that are opened
 * without corresponding cleanup via try/finally, using/with, or explicit close.
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// Patterns for resource acquisition
const RESOURCE_OPEN_PATTERNS: Array<{
  openPattern: RegExp;
  closePattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // JS/TS: fs.openSync / createReadStream without close
  {
    openPattern: /\b(?:createReadStream|createWriteStream|fs\.open|fs\.openSync|openSync)\s*\(/,
    closePattern: /\.close\s*\(\)|\.destroy\s*\(\)|\.end\s*\(\)/,
    languages: ['typescript', 'javascript'],
    description: 'stream/file opened without close',
  },
  // Python: open() without with-statement
  {
    openPattern: /\bopen\s*\([^)]*\)/,
    closePattern: /\bwith\s+open\b/,
    languages: ['python'],
    description: 'file opened without with-statement',
  },
  // Java/Kotlin: new FileInputStream etc. without try-with-resources
  {
    openPattern: /\bnew\s+(?:FileInputStream|FileOutputStream|BufferedReader|BufferedWriter|Connection|Socket)\s*\(/,
    closePattern: /\btry\s*\(|\.close\s*\(\)|try-with-resources/,
    languages: ['java', 'kotlin'],
    description: 'resource opened without try-with-resources or close',
  },
  // Go: os.Open without defer close
  {
    openPattern: /\bos\.Open\(|os\.Create\(|os\.OpenFile\(/,
    closePattern: /defer\s+.*\.Close\(\)/,
    languages: ['go'],
    description: 'file opened without defer Close',
  },
  // C#: new FileStream/SqlConnection without using
  {
    openPattern: /\bnew\s+(?:FileStream|StreamReader|StreamWriter|SqlConnection|WebClient)\s*\(/,
    closePattern: /\busing\s*\(|using\s+var|\.Dispose\s*\(\)|\.Close\s*\(\)/,
    languages: ['csharp'],
    description: 'resource opened without using/dispose',
  },
  // Rust: File::open / File::create without proper drop (usually safe but good to flag for explicit drop)
  {
    openPattern: /\bFile::open|File::create|File::options/,
    closePattern: /\bdrop\(|impl\s+Drop/,
    languages: ['rust'],
    description: 'file opened — verify explicit cleanup or rely on RAII',
  },
];

export const missingResourceRule: Rule = {
  definition: {
    id: 'detection:missing-resource',
    name: 'Missing resource release',
    description:
      'Detects resources (files, connections, streams) opened without ' +
      'corresponding cleanup (try/finally, using/with, defer close, or RAII).',
    severity: 'high',
    confidence: 0.8,
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
    const findings: string[] = [];

    for (const resource of RESOURCE_OPEN_PATTERNS) {
      if (resource.languages.length > 0 && !resource.languages.includes(language)) continue;

      const opened = resource.openPattern.test(content);
      if (!opened) continue;

      // Check if there's a guard (try/finally, using, with, defer)
      const hasGuard = /\btry\b[^}]*\bfinally\b/.test(content) ||
        /\busing\s*[\((]/.test(content) ||
        /\bwith\s+open\b/.test(content) ||
        /\bdefer\s+/.test(content);

      const hasClose = resource.closePattern.test(content);

      if (!hasClose && !hasGuard) {
        findings.push(resource.description);
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
      ruleId: 'detection:missing-resource',
      message: `${name}: ${findings[0]}`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'high',
      confidence: 0.8,
      evidence,
    };
  },
};
