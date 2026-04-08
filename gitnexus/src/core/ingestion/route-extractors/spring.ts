/**
 * Spring MVC route extractor.
 *
 * Extracts route definitions from Java and Kotlin files that use Spring
 * MVC / Spring WebFlux annotations. Handles:
 *   - @GetMapping("/path")        @PostMapping("/path")
 *   - @PutMapping("/path")        @DeleteMapping("/path")
 *   - @PatchMapping("/path")      @RequestMapping("/path")
 *   - @RequestMapping(value = "/path", method = RequestMethod.GET)
 *   - @RequestMapping({"path1", "path2"})   (multi-path array)
 *   - Class-level @RequestMapping("/api") combined with method-level paths
 *
 * Spring path variables ({id}, {slug:.*}) are normalised to
 * Next.js-compatible [param] dynamic segments.
 */

/** Minimal route shape needed by the pipeline's routeRegistry. */
export interface SpringRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

/**
 * True when the file content contains at least one Spring controller annotation.
 * Checks the content rather than the file path since controller files can have
 * any name.
 */
export function isSpringControllerFile(content: string): boolean {
  return /@(?:Rest)?Controller\b|@(?:Request|Get|Post|Put|Delete|Patch)Mapping\b/.test(content);
}

// Mapping annotation name → HTTP method
const MAPPING_METHODS: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
  RequestMapping: 'GET', // default when no method attribute
};

// Matches: @GetMapping("/path")  @GetMapping(value = "/path")  @GetMapping({"p1","p2"})
const MAPPING_RE =
  /@(GetMapping|PostMapping|PutMapping|DeleteMapping|PatchMapping|RequestMapping)\s*\(([^)]*)\)/g;

// Matches the `method = RequestMethod.GET` attribute inside the annotation
const METHOD_ATTR_RE = /\bmethod\s*=\s*(?:RequestMethod\.|HttpMethod\.)?(\w+)/;

// Matches a single path string inside the annotation parens
const SINGLE_PATH_RE = /["']([^"']+)["']/;

// Matches all path strings (for multi-path arrays {"p1","p2"})
const ALL_PATHS_RE = /["']([^"']+)["']/g;

// Matches Spring path variable: {id} or {id:regex} → [id]
const PATH_VAR_RE = /\{(\w+)(?::[^}]*)?\}/g;

/** Normalise a Spring path to a canonical URL segment string. */
function normaliseSpringPath(raw: string): string {
  let url = raw.trim();
  url = url.replace(PATH_VAR_RE, '[$1]');
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/** Extract class-level @RequestMapping prefix (if any). */
function extractClassPrefix(content: string): string {
  // Find a @RequestMapping that preceds `class` / `interface` declaration
  // We look for @RequestMapping annotation before a class keyword in the same block.
  const classRe =
    /@RequestMapping\s*\(\s*(?:value\s*=\s*)?(?:\{[^}]*\}|["']([^"']+)["'])[^)]*\)\s*(?:[\w\s@]*?)\s*(?:public\s+)?(?:(?:abstract|final|sealed|open|data|inner)\s+)*(?:class|interface|object)\b/g;
  let match: RegExpMatchArray | null;
  while ((match = classRe.exec(content)) !== null) {
    if (match[1]) return normaliseSpringPath(match[1]);
  }
  return '';
}

/**
 * Extract route definitions from the content of a Spring controller file.
 */
export function extractSpringRoutes(content: string, filePath: string): SpringRoute[] {
  const routes: SpringRoute[] = [];
  const classPrefix = extractClassPrefix(content);

  MAPPING_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = MAPPING_RE.exec(content)) !== null) {
    const annotationName = match[1];
    const argsStr = match[2];
    const defaultMethod = MAPPING_METHODS[annotationName] ?? 'GET';
    const lineNumber = content.slice(0, match.index).split('\n').length;

    // Determine HTTP method from `method = RequestMethod.XXX` if present
    const methodMatch = METHOD_ATTR_RE.exec(argsStr);
    const httpMethod = methodMatch ? methodMatch[1].toUpperCase() : defaultMethod;

    // Collect all path strings from the annotation
    const pathStrings: string[] = [];
    ALL_PATHS_RE.lastIndex = 0;
    let pathMatch: RegExpMatchArray | null;
    while ((pathMatch = ALL_PATHS_RE.exec(argsStr)) !== null) {
      // Skip string-valued `method` attributes (e.g. `produces = "application/json"`)
      const pathVal = pathMatch[1];
      if (/GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|application\//.test(pathVal)) continue;
      pathStrings.push(pathVal);
    }

    // If no explicit path strings, treat as mapping to the class prefix (root)
    if (pathStrings.length === 0) {
      const routePath = classPrefix || '/';
      routes.push({ routePath, httpMethod, filePath, lineNumber });
      continue;
    }

    for (const raw of pathStrings) {
      const methodSegment = normaliseSpringPath(raw);
      const routePath =
        classPrefix && !methodSegment.startsWith(classPrefix)
          ? normaliseSpringPath(classPrefix + '/' + methodSegment.replace(/^\//, ''))
          : methodSegment;
      routes.push({ routePath, httpMethod, filePath, lineNumber });
    }
  }

  return routes;
}
