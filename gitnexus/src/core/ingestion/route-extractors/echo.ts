/**
 * Echo (labstack/echo) route extractor.
 *
 * Extracts route definitions from Go files that use the Echo web framework.
 * Handles:
 *   - e.GET("/path", handler)       e.POST("/path", handler)
 *   - e.PUT("/path", handler)       e.DELETE("/path", handler)
 *   - e.PATCH("/path", handler)     e.HEAD("/path", handler)
 *   - e.OPTIONS("/path", handler)   e.Any("/path", handler)
 *   - e.HTTPMethod("/path", ...)    (any Echo API method)
 *
 * Echo path parameters (:id, *) are normalised to [id].
 */

/** Minimal route shape needed by the pipeline's routeRegistry. */
export interface EchoRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

// Matches: <receiver>.HTTP_METHOD("/path", ...)
// where receiver is typically 'e' or a variable bound to an Echo instance
const ECHO_ROUTE_RE =
  /\b(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*["'](\/[^"']*)["']/g;

/**
 * True when a Go file contains Echo-style route registrations.
 * Uses a broad pattern to detect any receiver.method("/path") style call,
 * similar to Gin. Since Gin is checked first in the dispatch chain,
 * this won't cause false positives.
 */
export function isEchoRouteFile(content: string): boolean {
  // Match any receiver.METHOD("/path") where METHOD is an HTTP verb
  return /\.\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*["']\//.test(
    content,
  );
}

/**
 * Normalise an Echo path: :id → [id], *any → [any]
 */
function normaliseEchoPath(raw: string): string {
  let url = raw.trim();
  url = url.replace(/[*:]([\w]+)/g, '[$1]');
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * Extract Echo route definitions from Go file content.
 */
export function extractEchoRoutes(content: string, filePath: string): EchoRoute[] {
  const routes: EchoRoute[] = [];
  ECHO_ROUTE_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = ECHO_ROUTE_RE.exec(content)) !== null) {
    const httpMethod = match[2] === 'Any' ? 'GET' : match[2].toUpperCase();
    const routePath = normaliseEchoPath(match[3]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  return routes;
}
