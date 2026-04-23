/**
 * Fiber (gofiber/fiber) route extractor.
 *
 * Extracts route definitions from Go files that use the Fiber web framework.
 * Handles:
 *   - app.Get("/path", handler)       app.Post("/path", handler)
 *   - app.Put("/path", handler)       app.Delete("/path", handler)
 *   - app.Patch("/path", handler)     app.Head("/path", handler)
 *   - app.Options("/path", handler)   app.Any("/path", handler)
 *   - app.Static("/prefix", "dir")   app.StaticFunc("/prefix", fiber.Static)
 *
 * Fiber path parameters (:id, *wildcard) are normalised to [id].
 */

/** Minimal route shape needed by the pipeline's routeRegistry. */
export interface FiberRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

// Matches Fiber v2/v3 camelCase style: app.Get("/path", ...)
// Also matches Fiber's HTTPMethod variants (Get, Post, Put, Delete, Patch, Head, Options, Any)
const FIBER_ROUTE_RE =
  /\b(\w+)\s*\.\s*(Get|Post|Put|Delete|Patch|Head|Options|Any)\s*\(\s*["'](\/[^"']*)["']/g;

/**
 * True when a Go file contains Fiber-style route registrations.
 * Detects the distinctive `app.HTTPMethod` pattern (camelCase with capital first letter)
 * used by Fiber framework. Excludes Gin/router style (lowercase) and Echo style (single 'e').
 */
export function isFiberRouteFile(content: string): boolean {
  // Match: app.Get, app.Post, app.Put, app.Delete, app.Patch, app.Head, app.Options, app.Any
  // Requires 'app' as receiver (Fiber's conventional variable name)
  return /\bapp\s*\.\s*(?:Get|Post|Put|Delete|Patch|Head|Options|Any)\s*\(\s*["']\//.test(content);
}

/**
 * Normalise a Fiber path: :id → [id], *wildcard → [wildcard]
 */
function normaliseFiberPath(raw: string): string {
  let url = raw.trim();
  url = url.replace(/:([\w]+)/g, '[$1]');
  url = url.replace(/\*([\w]*)/g, '[$1]');
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * Extract Fiber route definitions from Go file content.
 */
export function extractFiberRoutes(content: string, filePath: string): FiberRoute[] {
  const routes: FiberRoute[] = [];
  FIBER_ROUTE_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = FIBER_ROUTE_RE.exec(content)) !== null) {
    const httpMethod = match[2].toUpperCase();
    const routePath = normaliseFiberPath(match[3]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  return routes;
}
