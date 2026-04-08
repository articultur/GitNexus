/**
 * Path Traversal Detection Rule
 *
 * Detects user-controlled data being joined into file-system paths without
 * validation, enabling path traversal / directory traversal attacks
 * (OWASP A01:2021 / CWE-22).
 *
 * Identifies patterns like:
 *   - path.join(req.params.file, ...)
 *   - fs.readFile(__dirname + req.query.name, ...)
 *   - os.path.join(base, user_input)
 *   - filepath.Join(rootDir, r.URL.Query().Get("file"))
 *
 * A finding is suppressed if the surrounding context validates the path
 * (e.g. normalize + startsWith check, allowlist, regex, sanitize helper).
 */

import type { Rule, RuleContext, DetectionResult, Evidence } from '../types.js';

// User-controlled source patterns — the variable names are heuristic
const USER_INPUT_PATTERN =
  /(?:req\.|request\.|params\.|query\.|body\.|args\.|argv\[|sys\.argv|r\.URL|r\.Form|r\.PostForm|input\s*\(|getParameter|request\.getParam|request\.getQuery)/i;

// Path construction patterns per language
const PATH_CONSTRUCTION_PATTERNS: Array<{
  pattern: RegExp;
  languages: string[];
  description: string;
}> = [
  // JS/TS: path.join / path.resolve / path.normalize with user input
  {
    pattern: /path\.(?:join|resolve|normalize)\s*\([^)]*(?:req\.|params\.|query\.|body\.)/i,
    languages: ['typescript', 'javascript'],
    description: 'path.join/resolve with request-derived input — potential path traversal',
  },
  // JS/TS: __dirname / __filename + user input concatenation
  {
    pattern:
      /__dirname\s*\+\s*(?:\w+\.(?:params|query|body)|userInput|filePath|fileName|file|name)/i,
    languages: ['typescript', 'javascript'],
    description: '__dirname + unvalidated variable — potential path traversal',
  },
  // JS/TS: fs.readFile / fs.createReadStream with direct user input
  {
    pattern:
      /fs\s*\.\s*(?:readFile|createReadStream|open|access|stat|unlink|rmdir|mkdir|writeFile)\s*\([^,)]*(?:req\.|params\.|query\.|body\.)/i,
    languages: ['typescript', 'javascript'],
    description: 'fs API call with request-derived path — potential path traversal',
  },
  // Python: os.path.join with common user-input variable names
  {
    pattern:
      /os\.path\.join\s*\([^)]*(?:request\.|args\.|argv\[|input\s*\(|param|query|filename|filepath|file_name|file_path)/i,
    languages: ['python'],
    description: 'os.path.join with user-controlled argument — potential path traversal',
  },
  // Python: open() / pathlib.Path with user input
  {
    pattern:
      /(?:open\s*\(|Path\s*\()[^)]*(?:request\.|args\.|argv\[|input\s*\(|param|query|filename)/i,
    languages: ['python'],
    description: 'open()/Path() with user-controlled argument — potential path traversal',
  },
  // Go: filepath.Join — direct injection or via intermediate variable after r.URL/r.Form assignment
  {
    pattern:
      /filepath\.Join\s*\([^)]*(?:r\.URL|r\.Form|r\.PostForm|mux\.Vars|chi\.URLParam|query\.Get|PathValue|\br\b)/i,
    languages: ['go'],
    description: 'filepath.Join with request-derived input — potential path traversal',
  },
  // Go: filepath.Join with intermediate variable assigned from user input (two-line pattern: assign + join in same symbol)
  {
    pattern:
      /(?:r\.URL|r\.Form|r\.PostForm|mux\.Vars|chi\.URLParam|query\.Get)[\s\S]{0,200}filepath\.Join/i,
    languages: ['go'],
    description: 'filepath.Join used after extracting from HTTP request — potential path traversal',
  },
  // Go: os.Open / os.ReadFile with request input
  {
    pattern:
      /os\.(?:Open|ReadFile|Create|Remove|MkdirAll|Stat)\s*\([^)]*(?:r\.URL|r\.Form|r\.PostForm|mux\.Vars)/i,
    languages: ['go'],
    description: 'os file API with request-derived path — potential path traversal',
  },
  // Java: new File() / Paths.get() with user input
  {
    pattern:
      /(?:new\s+File\s*\(|Paths\.get\s*\()[^)]*(?:request\.getParam|request\.getQuery|getParameter|param|query|filePath|fileName)/i,
    languages: ['java', 'kotlin'],
    description: 'new File()/Paths.get() with request-derived argument — potential path traversal',
  },
  // PHP: file_get_contents / fopen with $_GET/$_POST/$_REQUEST
  {
    pattern:
      /(?:file_get_contents|fopen|include|require|file_put_contents)\s*\([^)]*\$_(?:GET|POST|REQUEST|COOKIE)/i,
    languages: ['php'],
    description: 'File operation with superglobal ($_GET etc.) — potential path traversal / LFI',
  },
  // Ruby: File.read/open with user param
  {
    pattern: /(?:File\.(?:read|open|new)|IO\.read)\s*\([^)]*(?:params\[|request\.|env\[)/i,
    languages: ['ruby'],
    description: 'File.read/open with params — potential path traversal',
  },
];

// Patterns indicating the path is validated (reduce false positives)
const SAFE_PATTERNS: RegExp[] = [
  /normalize\s*\(/, // path.normalize
  /\.startsWith\s*\(/, // directory containment check
  /\.indexOf\s*\(['"]\.\.['"]/, // explicit ../ detection
  /\.includes\s*\(['"]\.\.['"]/, // explicit ../ detection
  /allowlist|whitelist|allowedPaths|allowedFiles/i, // allowlist lookup
  /sanitize|sanitise|escapePath/i, // sanitize helper
  /\.\.(\/|\\)/, // explicit literal "../" (indicating an existing check)
  /abspath|realpath|canonicalize/i, // canonical path resolution (Python)
  /filepath\.Clean|filepath\.Abs/i, // Go canonical resolution
  /Paths\.get.*toAbsolutePath|\.toAbsolutePath/i, // Java canonical resolution
];

/**
 * Check whether a path-construction pattern is accompanied by validation.
 */
function hasPathValidation(content: string, matchIndex: number): boolean {
  const start = Math.max(0, matchIndex - 300);
  const end = Math.min(content.length, matchIndex + 300);
  const window = content.slice(start, end);
  return SAFE_PATTERNS.some((p) => p.test(window));
}

export const pathTraversalRule: Rule = {
  definition: {
    id: 'detection:path-traversal',
    name: 'Path Traversal risk',
    description:
      'Detects user-controlled input being joined into filesystem paths without ' +
      'validation — enabling directory traversal attacks (OWASP A01:2021 / CWE-22).',
    severity: 'high',
    confidence: 0.7,
    languages: ['typescript', 'javascript', 'python', 'java', 'kotlin', 'go', 'php', 'ruby'],
    trigger: {
      propertyConditions: [{ property: 'content', operator: 'not_contains', value: '""' }],
    },
    missing: {},
  },

  evaluate(ctx: RuleContext): DetectionResult | null {
    const content = ctx.node.properties.content as string | undefined;
    if (!content || content.length < 10) return null;

    // Quick pre-check: any path-construction keyword present?
    if (!/(?:path\.|os\.path|filepath|fs\.|File\(|fopen|file_get)/i.test(content)) {
      // Go / generic fallback: also check for plain directory traversal hints
      if (!USER_INPUT_PATTERN.test(content)) return null;
    }

    const language = ctx.language;
    const findings: Array<{ match: RegExpMatchArray; description: string }> = [];

    for (const pat of PATH_CONSTRUCTION_PATTERNS) {
      if (pat.languages.length > 0 && !pat.languages.includes(language)) continue;

      const re = new RegExp(pat.pattern.source, 'gi');
      let match: RegExpMatchArray | null;
      while ((match = re.exec(content)) !== null) {
        if (!hasPathValidation(content, match.index!)) {
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
      ruleId: 'detection:path-traversal',
      message: `${name}: ${findings.length} unvalidated path construction pattern(s) detected — possible path traversal`,
      symbolName: name,
      symbolId: ctx.node.id,
      filePath,
      severity: 'high',
      confidence: Math.min(0.85, 0.6 + findings.length * 0.05),
      evidence,
    };
  },
};
