/**
 * Laravel (PHP) explicit route extractor.
 *
 * Patterns handled:
 *   - Route::get('/path', [Controller::class, 'method'])
 *   - Route::post('/path', 'Controller@method')
 *   - Route::put('/path', [Controller::class, 'method'])
 *   - Route::delete('/path', [Controller::class, 'method'])
 *   - Route::patch('/path', [Controller::class, 'method'])
 *   - Route::resource('name', Controller::class)
 *   - Route::apiResource('name', Controller::class)
 *   - $router->get('/path', 'Controller@method')
 */

export interface LaravelRoute {
  routePath: string;
  httpMethod: string;
  filePath: string;
  lineNumber: number;
}

const LARAVEL_ROUTE_RE = /Route::(get|post|put|delete|patch|options)\s*\(\s*['"]([^'"]+)['"]/gi;

const LARAVEL_RESOURCE_RE = /Route::(apiResource|resource)\s*\(\s*['"]([^'"]+)['"]/gi;

const LARAVEL_PREFIX_GROUP_START_RE =
  /Route::(?:(?:middleware\([^)]*\)->)?prefix\s*\(\s*['"]([^'"]+)['"]\s*\)(?:->middleware\([^)]*\))?|middleware\([^)]*\)->prefix\s*\(\s*['"]([^'"]+)['"]\s*\))->group\s*\(\s*function\s*\([^)]*\)\s*\{/gi;

const ROUTER_METHOD_RE =
  /\$(?:router|app)->(get|post|put|delete|patch|options)\s*\(\s*['"]([^'"]+)['"]/gi;

function normaliseLaravelPath(raw: string, prefix = ''): string {
  let url = `${prefix}/${raw}`.trim();
  if (!url.startsWith('/')) url = '/' + url;
  url = url.replace(/\/+/g, '/');
  url = url.replace(/\{([^}/]+)\}/g, '[$1]');
  if (url.length > 1 && url.endsWith('/')) url = url.slice(0, -1);
  return url;
}

function isInExcludedRange(
  index: number,
  excludedRanges: Array<{ start: number; end: number }>,
): boolean {
  return excludedRanges.some((range) => index >= range.start && index < range.end);
}

function findMatchingBrace(content: string, openBraceIndex: number): number {
  let depth = 0;
  for (let i = openBraceIndex; i < content.length; i++) {
    const char = content[i];
    if (char === '{') depth++;
    if (char === '}') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function extractPrefixedGroups(
  content: string,
): Array<{ prefix: string; body: string; start: number; end: number }> {
  const groups: Array<{ prefix: string; body: string; start: number; end: number }> = [];
  LARAVEL_PREFIX_GROUP_START_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;

  while ((match = LARAVEL_PREFIX_GROUP_START_RE.exec(content)) !== null) {
    const prefix = match[1] || match[2];
    if (!prefix) continue;
    const openBraceIndex = content.indexOf('{', match.index + match[0].length - 1);
    if (openBraceIndex < 0) continue;
    const closeBraceIndex = findMatchingBrace(content, openBraceIndex);
    if (closeBraceIndex < 0) continue;
    groups.push({
      prefix,
      body: content.slice(openBraceIndex + 1, closeBraceIndex),
      start: match.index,
      end: closeBraceIndex + 1,
    });
    LARAVEL_PREFIX_GROUP_START_RE.lastIndex = closeBraceIndex + 1;
  }

  return groups;
}

/**
 * True when the file looks like a Laravel routes file.
 */
export function isLaravelRouteFile(content: string, filePath?: string): boolean {
  if (filePath && /routes\/(?:web|api|console|channels)\.php$/.test(filePath)) return true;
  return /Route::(get|post|put|delete|patch|resource|apiResource|group|middleware)/i.test(content);
}

/**
 * Extract Laravel route definitions from PHP file content.
 */
export function extractLaravelRoutes(content: string, filePath: string): LaravelRoute[] {
  const routes: LaravelRoute[] = [];
  const excludedRanges: Array<{ start: number; end: number }> = [];

  for (const group of extractPrefixedGroups(content)) {
    excludedRanges.push({ start: group.start, end: group.end });
    const lineOffset = content.slice(0, group.start).split('\n').length - 1;
    const nestedRoutes = extractLaravelRoutes(group.body, filePath);
    for (const route of nestedRoutes) {
      routes.push({
        ...route,
        routePath: normaliseLaravelPath(route.routePath, group.prefix),
        lineNumber: route.lineNumber + lineOffset,
      });
    }
  }

  LARAVEL_ROUTE_RE.lastIndex = 0;
  let match: RegExpMatchArray | null;
  while ((match = LARAVEL_ROUTE_RE.exec(content)) !== null) {
    if (isInExcludedRange(match.index, excludedRanges)) continue;
    const httpMethod = match[1].toUpperCase();
    const routePath = normaliseLaravelPath(match[2]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  LARAVEL_RESOURCE_RE.lastIndex = 0;
  while ((match = LARAVEL_RESOURCE_RE.exec(content)) !== null) {
    if (isInExcludedRange(match.index, excludedRanges)) continue;
    const isApi = match[1] === 'apiResource';
    const resourceName = match[2].trim();
    const base = '/' + resourceName;
    const lineNumber = content.slice(0, match.index).split('\n').length;

    const resourceRoutes = isApi
      ? [
          { path: base, method: 'GET' },
          { path: base, method: 'POST' },
          { path: base + '/[id]', method: 'GET' },
          { path: base + '/[id]', method: 'PUT' },
          { path: base + '/[id]', method: 'DELETE' },
        ]
      : [
          { path: base, method: 'GET' },
          { path: base + '/create', method: 'GET' },
          { path: base, method: 'POST' },
          { path: base + '/[id]', method: 'GET' },
          { path: base + '/[id]/edit', method: 'GET' },
          { path: base + '/[id]', method: 'PUT' },
          { path: base + '/[id]', method: 'DELETE' },
        ];

    for (const r of resourceRoutes) {
      routes.push({ routePath: r.path, httpMethod: r.method, filePath, lineNumber });
    }
  }

  ROUTER_METHOD_RE.lastIndex = 0;
  while ((match = ROUTER_METHOD_RE.exec(content)) !== null) {
    if (isInExcludedRange(match.index, excludedRanges)) continue;
    const httpMethod = match[1].toUpperCase();
    const routePath = normaliseLaravelPath(match[2]);
    const lineNumber = content.slice(0, match.index).split('\n').length;
    routes.push({ routePath, httpMethod, filePath, lineNumber });
  }

  return routes;
}
