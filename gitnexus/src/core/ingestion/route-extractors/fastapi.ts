/**
 * FastAPI (Python) and Gin/Echo/Fiber (Go) route extractor.
 *
 * FastAPI patterns handled:
 *   - @app.get("/path")          @app.post("/path")
 *   - @router.get("/path")       @router.post("/path/{id}")
 *   - @api_router.get("/path")   (any variable name before the HTTP method)
 *   - Decorator arguments: "/path", response_model=..., status_code=...
 *
 * Gin / Echo / Fiber patterns handled (Go HTTP routers):
 *   - r.GET("/path", handler)        router.POST("/users", h)
 *   - e.GET("/path", handler)        g.DELETE("/path/:id", h)
 *   - v1.GET("/path", handler)       (any short ident before .HTTP_METHOD)
 *
 * FastAPI path parameters ({item_id}, {item_id:path}) are normalised to [item_id].
 * Gin / Echo path parameters (:id, *any) are normalised to [id].
 */

/** Minimal route shape needed by the pipeline's routeRegistry. */
export interface FastAPIRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

export interface GinRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

// ---------------------------------------------------------------------------
// FastAPI
// ---------------------------------------------------------------------------

// Matches: @<var>.<method>("/path") or @<var>.<method>("/path", ...)
// where method is one of the HTTP verb names used by FastAPI
const FASTAPI_DECORATOR_RE =
  /@\w+\.(get|post|put|delete|patch|head|options|trace)\s*\(\s*["']([^"']+)["']/gi;

/** Path parameter normalisation: {item_id} → [item_id], {item_id:path} → [item_id] */
function normaliseFastAPIPath(raw: string): string {
  let url = raw.trim();
  url = url.replace(/\{(\w+)(?::[^}]*)?\}/g, '[$1]');
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * True when the file looks like a FastAPI application.
 * Checks for `@app.get` / `@router.post` style decorator usage.
 */
export function isFastAPIFile(content: string): boolean {
  return /@\w+\.(get|post|put|delete|patch|head|options|trace)\s*\(/i.test(content);
}

/**
 * Extract FastAPI route definitions from Python file content.
 */
export function extractFastAPIRoutes(content: string, filePath: string): FastAPIRoute[] {
  const routes: FastAPIRoute[] = [];
  FASTAPI_DECORATOR_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = FASTAPI_DECORATOR_RE.exec(content)) !== null) {
    const httpMethod = match[1].toUpperCase();
    const routePath = normaliseFastAPIPath(match[2]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  return routes;
}

// ---------------------------------------------------------------------------
// Gin / Echo / Fiber (Go)
// ---------------------------------------------------------------------------

// Matches: <receiver>.GET("/path", ...) where GET is an HTTP verb method
// Receiver is a short Go identifier (r, e, v1, router, g, etc.)
// Also matches Fiber camelCase: app.Get("/path"), app.Post("/path")
const GIN_ROUTE_RE =
  /\b(\w+)\s*\.\s*(GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*["'](\/[^"']*)["']/g;

/**
 * Normalise a Gin/Echo path: :id → [id], *any → [any], strip trailing slash.
 */
function normaliseGinPath(raw: string): string {
  let url = raw.trim();
  url = url.replace(/[*:]([\w]+)/g, '[$1]');
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * True when a Go file contains Gin / Echo / Fiber style route registrations.
 */
export function isGinRouteFile(content: string): boolean {
  return /\.\s*(?:GET|POST|PUT|DELETE|PATCH|HEAD|OPTIONS|Any|Get|Post|Put|Delete|Patch|Head|Options)\s*\(\s*["']\//.test(
    content,
  );
}

/**
 * Extract Gin / Echo / Fiber route definitions from Go file content.
 */
export function extractGinRoutes(content: string, filePath: string): GinRoute[] {
  const routes: GinRoute[] = [];
  GIN_ROUTE_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = GIN_ROUTE_RE.exec(content)) !== null) {
    const httpMethod = match[2] === 'Any' ? 'GET' : match[2].toUpperCase();
    const routePath = normaliseGinPath(match[3]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  return routes;
}
