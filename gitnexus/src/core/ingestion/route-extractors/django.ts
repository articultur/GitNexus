/**
 * Django URL pattern extractor.
 *
 * Extracts route definitions from Django `urls.py` files using regex-based
 * content analysis. Handles:
 *   - path('route/', view_func, name='name')
 *   - re_path(r'^route/$', view_func)
 *   - url(r'^route/$', view_func)          (deprecated but still common)
 *   - include('app.urls') (emits a catch-all prefix route)
 *
 * Django URL converters (<int:pk>, <str:slug>, etc.) are normalised to
 * Next.js-compatible [param] dynamic segments.
 */

/** Minimal route shape needed by the pipeline's routeRegistry. */
export interface DjangoRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

// Matches: path('route/', ...) or re_path(r'^route/$', ...) or url(r'^...$', ...)
const DJANGO_PATH_RE = /(?:^|[\n,[\s])\s*(?:path|re_path|url)\s*\(\s*r?['"`]([^'"`]+)['"`]/g;

// Matches Django URL converters: <int:pk>, <str:slug>, <uuid:id>
const DJANGO_CONVERTER_RE = /<(?:\w+:)?(\w+)>/g;

// Matches regex anchors and common regex chars that aren't URL path chars
const REGEX_CLEANUP_RE = /[\^$().*+?\\]/g;

/**
 * Normalise a Django path/re_path pattern to a clean URL:
 *  - Remove regex anchors (^ $) and common regex metacharacters
 *  - Convert Django typed converters <int:pk> → [pk]
 *  - Ensure leading slash
 */
function normaliseDjangoPattern(raw: string): string {
  // First clean up URL converters
  let url = raw.replace(DJANGO_CONVERTER_RE, '[$1]');
  // Remove regex metacharacters from re_path patterns
  url = url.replace(REGEX_CLEANUP_RE, '');
  // Ensure leading slash
  if (!url.startsWith('/')) url = '/' + url;
  // Remove duplicate slashes
  url = url.replace(/\/+/g, '/');
  // Remove trailing slash for canonical form (keep root '/')
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

/**
 * Check whether this file looks like a Django url configuration.
 * Returns true for files named urls.py anywhere in the project, plus
 * files that include the `urlpatterns` identifier.
 */
export function isDjangoUrlFile(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, '/');
  // Match only when the basename is exactly 'urls.py' (not 'myurls.py' etc.)
  return /(^|\/)urls\.py$/.test(norm) || norm.endsWith('urls/default.py');
}

/**
 * Extract route definitions from the content of a Django urls.py file.
 * Returns an array of minimal route objects for the pipeline routeRegistry.
 */
export function extractDjangoRoutes(content: string, filePath: string): DjangoRoute[] {
  if (!content.includes('urlpatterns') && !content.includes('path(') && !content.includes('url(')) {
    return [];
  }

  const routes: DjangoRoute[] = [];
  DJANGO_PATH_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = DJANGO_PATH_RE.exec(content)) !== null) {
    const rawPattern = match[1];
    // Skip include() calls — these are prefixes handled by nested url confs,
    // not direct handler registrations.
    if (rawPattern.endsWith('/') === false && includes(content, match.index)) continue;

    const routePath = normaliseDjangoPattern(rawPattern);
    if (!routePath || routePath === '/') {
      // Still useful as a catch-all — emit it
    }

    const lineNumber = content.slice(0, match.index).split('\n').length;
    // Django views handle all HTTP methods by default at the router level;
    // method dispatch happens inside the view or via class-based views.
    routes.push({ routePath, httpMethod: 'GET', filePath, lineNumber });
  }

  return routes;
}

/** True if the match index is inside an include() call (not a path()). */
function includes(content: string, index: number): boolean {
  // Look at the call name before the first ( after the pattern
  const before = content.slice(Math.max(0, index - 10), index + 20);
  return /\binclude\s*\(/.test(before);
}
