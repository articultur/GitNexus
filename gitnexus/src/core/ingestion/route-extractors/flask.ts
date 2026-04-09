/**
 * Flask (Python) route extractor.
 *
 * Patterns handled:
 *   - @app.route("/path")
 *   - @app.route("/path", methods=["GET", "POST"])
 *   - @blueprint.route("/path")
 *   - @bp.route("/path", methods=["GET"])
 *   - Any @<var>.route("/path") decorator pattern
 *
 * Flask path parameters (<name>, <converter:name>) are normalised to [name].
 */

export interface FlaskRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

// Matches: @<var>.route("/path") or @<var>.route("/path", methods=["GET", "POST"])
const FLASK_ROUTE_RE =
  /@(\w+)\.route\s*\(\s*["']([^"']+)["']\s*(?:,\s*(?:methods\s*=\s*\[([^\]]*)\]|[^)]*?))?\)/gi;
const FLASK_METHOD_DECORATOR_RE =
  /@(\w+)\.(get|post|put|delete|patch|options)\s*\(\s*["']([^"']+)["']\s*\)/gi;

// Extract HTTP methods from the methods=[...] part
const METHOD_STRING_RE = /["'](\w+)["']/g;

/** Path parameter normalisation: <name> → [name], <converter:name> → [name] */
function normaliseFlaskPath(raw: string): string {
  let url = raw.trim();
  url = url.replace(/<(?:\w+:)?(\w+)>/g, '[$1]');
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/** Extract HTTP methods from the methods=[...] argument. Defaults to ['GET']. */
function extractMethods(methodsStr: string | null | undefined): string[] {
  if (!methodsStr) return ['GET'];
  const methods: string[] = [];
  METHOD_STRING_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;
  while ((match = METHOD_STRING_RE.exec(methodsStr)) !== null) {
    methods.push(match[1].toUpperCase());
  }
  return methods.length > 0 ? methods : ['GET'];
}

/**
 * True when the file looks like a Flask application.
 * Checks for @<var>.route() style decorator usage.
 */
export function isFlaskFile(content: string): boolean {
  return /@\w+\.(?:route|get|post|put|delete|patch|options)\s*\(\s*["']/i.test(content);
}

/**
 * Extract Flask route definitions from Python file content.
 */
export function extractFlaskRoutes(content: string, filePath: string): FlaskRoute[] {
  const routes: FlaskRoute[] = [];
  FLASK_ROUTE_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = FLASK_ROUTE_RE.exec(content)) !== null) {
    const httpMethods = extractMethods(match[3]);
    const routePath = normaliseFlaskPath(match[2]);
    const lineNumber = content.slice(0, match.index).split('\n').length;

    for (const method of httpMethods) {
      routes.push({ routePath, httpMethod: method, filePath, lineNumber });
    }
  }

  FLASK_METHOD_DECORATOR_RE.lastIndex = 0;
  while ((match = FLASK_METHOD_DECORATOR_RE.exec(content)) !== null) {
    const httpMethod = match[2].toUpperCase();
    const routePath = normaliseFlaskPath(match[3]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  return routes;
}
