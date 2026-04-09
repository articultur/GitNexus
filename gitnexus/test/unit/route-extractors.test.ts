/**
 * Unit tests for Django, Rails, Flask, Laravel, and Fiber route extractors.
 */

import { describe, expect, it } from 'vitest';
import {
  isDjangoUrlFile,
  extractDjangoRoutes,
} from '../../src/core/ingestion/route-extractors/django.js';
import {
  isRailsRouteFile,
  extractRailsRoutes,
} from '../../src/core/ingestion/route-extractors/rails.js';
import {
  isFlaskFile,
  extractFlaskRoutes,
} from '../../src/core/ingestion/route-extractors/flask.js';
import {
  isLaravelRouteFile,
  extractLaravelRoutes,
} from '../../src/core/ingestion/route-extractors/laravel.js';
import {
  isGinRouteFile,
  extractGinRoutes,
} from '../../src/core/ingestion/route-extractors/fastapi.js';

// ── Django ────────────────────────────────────────────────────────────────────

describe('isDjangoUrlFile', () => {
  it('matches urls.py at any depth', () => {
    expect(isDjangoUrlFile('myapp/urls.py')).toBe(true);
    expect(isDjangoUrlFile('urls.py')).toBe(true);
    expect(isDjangoUrlFile('project/app/urls.py')).toBe(true);
  });

  it('matches urls/default.py', () => {
    expect(isDjangoUrlFile('project/urls/default.py')).toBe(true);
  });

  it('does not match other python files', () => {
    expect(isDjangoUrlFile('views.py')).toBe(false);
    expect(isDjangoUrlFile('models.py')).toBe(false);
    expect(isDjangoUrlFile('myurls.py')).toBe(false);
  });

  it('handles Windows-style paths', () => {
    expect(isDjangoUrlFile('app\\urls.py')).toBe(true);
  });
});

describe('extractDjangoRoutes', () => {
  const FILE = 'myapp/urls.py';

  it('returns empty array when no urlpatterns or path() calls', () => {
    expect(extractDjangoRoutes('# nothing here', FILE)).toHaveLength(0);
  });

  it('extracts simple path() route', () => {
    const content = `
urlpatterns = [
    path('users/', views.user_list),
]`;
    const routes = extractDjangoRoutes(content, FILE);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].routePath).toBe('/users');
    expect(routes[0].filePath).toBe(FILE);
    expect(typeof routes[0].lineNumber).toBe('number');
  });

  it('extracts re_path() route and cleans regex chars', () => {
    const content = `
urlpatterns = [
    re_path(r'^articles/$', views.article_list),
]`;
    const routes = extractDjangoRoutes(content, FILE);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].routePath).toBe('/articles');
  });

  it('converts Django typed converters to [param] segments', () => {
    const content = `
urlpatterns = [
    path('users/<int:pk>/', views.user_detail),
]`;
    const routes = extractDjangoRoutes(content, FILE);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].routePath).toBe('/users/[pk]');
  });

  it('converts str converter to [param]', () => {
    const content = `
urlpatterns = [
    path('articles/<str:slug>/', views.article_detail),
]`;
    const routes = extractDjangoRoutes(content, FILE);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].routePath).toBe('/articles/[slug]');
  });

  it('extracts multiple routes', () => {
    const content = `
urlpatterns = [
    path('', views.index),
    path('about/', views.about),
    path('users/', views.user_list),
]`;
    const routes = extractDjangoRoutes(content, FILE);
    expect(routes.length).toBeGreaterThanOrEqual(2);
  });

  it('sets httpMethod to GET (Django dispatches per-view)', () => {
    const content = `
urlpatterns = [path('orders/', views.orders)]`;
    const routes = extractDjangoRoutes(content, FILE);
    expect(routes.length).toBeGreaterThan(0);
    expect(routes[0].httpMethod).toBe('GET');
  });
});

// ── Rails ─────────────────────────────────────────────────────────────────────

describe('isRailsRouteFile', () => {
  it('matches config/routes.rb', () => {
    expect(isRailsRouteFile('config/routes.rb')).toBe(true);
  });

  it('matches routes.rb standalone', () => {
    expect(isRailsRouteFile('routes.rb')).toBe(true);
  });

  it('matches config/routes/admin.rb', () => {
    expect(isRailsRouteFile('config/routes/admin.rb')).toBe(true);
  });

  it('does not match other ruby files', () => {
    expect(isRailsRouteFile('app/models/user.rb')).toBe(false);
    expect(isRailsRouteFile('app/controllers/users_controller.rb')).toBe(false);
  });

  it('handles Windows-style paths', () => {
    expect(isRailsRouteFile('config\\routes.rb')).toBe(true);
  });
});

describe('extractRailsRoutes', () => {
  const FILE = 'config/routes.rb';

  it('extracts GET verb route', () => {
    const content = `
Rails.application.routes.draw do
  get '/users', to: 'users#index'
end`;
    const routes = extractRailsRoutes(content, FILE);
    const get = routes.find((r) => r.routePath === '/users' && r.httpMethod === 'GET');
    expect(get).toBeDefined();
    expect(get!.filePath).toBe(FILE);
  });

  it('extracts POST verb route', () => {
    const content = `post '/users', to: 'users#create'`;
    const routes = extractRailsRoutes(content, FILE);
    const post = routes.find((r) => r.routePath === '/users' && r.httpMethod === 'POST');
    expect(post).toBeDefined();
  });

  it('normalises :param to [param]', () => {
    const content = `get '/users/:id', to: 'users#show'`;
    const routes = extractRailsRoutes(content, FILE);
    const route = routes.find((r) => r.httpMethod === 'GET');
    expect(route).toBeDefined();
    expect(route!.routePath).toBe('/users/[id]');
  });

  it('expands resources :users to REST routes', () => {
    const content = `
Rails.application.routes.draw do
  resources :users
end`;
    const routes = extractRailsRoutes(content, FILE);
    // resources generates 8 routes (index, create, show, update x2, destroy, new, edit)
    const userRoutes = routes.filter((r) => r.routePath.startsWith('/users'));
    expect(userRoutes.length).toBe(8);
    expect(userRoutes.some((r) => r.httpMethod === 'GET' && r.routePath === '/users')).toBe(true);
    expect(userRoutes.some((r) => r.httpMethod === 'POST' && r.routePath === '/users')).toBe(true);
    expect(userRoutes.some((r) => r.httpMethod === 'DELETE' && r.routePath === '/users/[id]')).toBe(
      true,
    );
  });

  it('expands singular resource :profile to 7 routes', () => {
    const content = `resource :profile`;
    const routes = extractRailsRoutes(content, FILE);
    const profileRoutes = routes.filter((r) => r.routePath.startsWith('/profile'));
    expect(profileRoutes.length).toBe(7);
  });

  it('emits GET route for namespace', () => {
    const content = `
namespace :api do
  resources :users
end`;
    const routes = extractRailsRoutes(content, FILE);
    const nsRoute = routes.find((r) => r.routePath === '/api');
    expect(nsRoute).toBeDefined();
    expect(nsRoute!.httpMethod).toBe('GET');
  });

  it('emits route for scope prefix', () => {
    const content = `scope '/v1' do\n  resources :users\nend`;
    const routes = extractRailsRoutes(content, FILE);
    const scopeRoute = routes.find((r) => r.routePath === '/v1');
    expect(scopeRoute).toBeDefined();
  });

  it('returns empty array for empty content', () => {
    expect(extractRailsRoutes('', FILE)).toHaveLength(0);
  });

  it('sets filePath on all routes', () => {
    const content = `get '/ping', to: 'health#ping'`;
    const routes = extractRailsRoutes(content, FILE);
    expect(routes.every((r) => r.filePath === FILE)).toBe(true);
  });
});

// ── Flask ─────────────────────────────────────────────────────────────────────

describe('isFlaskFile', () => {
  it('detects @app.route', () => {
    expect(isFlaskFile('@app.route("/users")\ndef get_users(): pass')).toBe(true);
  });

  it('detects @blueprint.route', () => {
    expect(isFlaskFile('@bp.route("/items")\ndef list_items(): pass')).toBe(true);
  });

  it('detects method-specific Flask decorators', () => {
    expect(isFlaskFile('@app.get("/users")\ndef get_users(): pass')).toBe(true);
  });

  it('rejects non-Flask files', () => {
    expect(isFlaskFile('def hello(): pass')).toBe(false);
    expect(isFlaskFile('@decorator_without_args')).toBe(false);
  });
});

describe('extractFlaskRoutes', () => {
  const FILE = 'app.py';

  it('extracts simple GET route', () => {
    const content = `@app.route("/users")\ndef list_users(): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/users');
    expect(routes[0].httpMethod).toBe('GET');
  });

  it('extracts route with explicit methods', () => {
    const content = `@app.route("/users", methods=["GET", "POST"])\ndef users(): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes).toHaveLength(2);
    expect(routes.map((r) => r.httpMethod).sort()).toEqual(['GET', 'POST']);
  });

  it('normalises path parameters <name> to [name]', () => {
    const content = `@app.route("/users/<int:user_id>")\ndef get_user(user_id): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes[0].routePath).toBe('/users/[user_id]');
  });

  it('extracts blueprint routes', () => {
    const content = `@bp.route("/items/<item_id>")\ndef get_item(item_id): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/items/[item_id]');
  });

  it('extracts method-specific Flask decorators', () => {
    const content = `@app.post("/users")\ndef create_user(): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/users');
    expect(routes[0].httpMethod).toBe('POST');
  });

  it('extracts multiple routes from same file', () => {
    const content = `
@app.route("/")
def index(): pass

@app.route("/about")
def about(): pass

@app.route("/api/data", methods=["GET", "POST"])
def data(): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes).toHaveLength(4); // / (GET) + /about (GET) + /api/data (GET + POST)
  });

  it('returns empty array for empty content', () => {
    expect(extractFlaskRoutes('', FILE)).toHaveLength(0);
  });

  it('sets filePath on all routes', () => {
    const content = `@app.route("/ping")\ndef ping(): pass`;
    const routes = extractFlaskRoutes(content, FILE);
    expect(routes.every((r) => r.filePath === FILE)).toBe(true);
  });
});

// ── Laravel ──────────────────────────────────────────────────────────────────

describe('isLaravelRouteFile', () => {
  it('matches routes/web.php', () => {
    expect(isLaravelRouteFile('', 'routes/web.php')).toBe(true);
  });

  it('matches routes/api.php', () => {
    expect(isLaravelRouteFile('', 'routes/api.php')).toBe(true);
  });

  it('detects Route::get in content', () => {
    expect(isLaravelRouteFile("Route::get('/users', [UserController::class, 'index'])")).toBe(true);
  });

  it('rejects non-Laravel PHP files', () => {
    expect(isLaravelRouteFile('<?php echo "hello";')).toBe(false);
  });
});

describe('extractLaravelRoutes', () => {
  const FILE = 'routes/web.php';

  it('extracts Route::get', () => {
    const content = "Route::get('/users', [UserController::class, 'index']);";
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/users');
    expect(routes[0].httpMethod).toBe('GET');
  });

  it('extracts Route::post', () => {
    const content = "Route::post('/users', [UserController::class, 'store']);";
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes[0].httpMethod).toBe('POST');
  });

  it('extracts multiple routes', () => {
    const content = `
Route::get('/users', [UserController::class, 'index']);
Route::post('/users', [UserController::class, 'store']);
Route::put('/users/{id}', [UserController::class, 'update']);
Route::delete('/users/{id}', [UserController::class, 'destroy']);`;
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(4);
  });

  it('expands Route::resource to 7 REST routes', () => {
    const content = "Route::resource('posts', PostController::class);";
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(7);
  });

  it('expands Route::apiResource to 5 routes', () => {
    const content = "Route::apiResource('posts', PostController::class);";
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(5);
  });

  it('extracts $router->get calls', () => {
    const content = "$router->get('/api/ping', 'PingController@index');";
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/api/ping');
  });

  it('extracts prefixed group routes', () => {
    const content = `
Route::prefix('api')->group(function () {
    Route::get('/users/{id}', [UserController::class, 'show']);
    Route::post('users', [UserController::class, 'store']);
});`;
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(2);
    expect(routes.find((r) => r.httpMethod === 'GET')?.routePath).toBe('/api/users/[id]');
    expect(routes.find((r) => r.httpMethod === 'POST')?.routePath).toBe('/api/users');
  });

  it('extracts prefixed group routes with middleware chain', () => {
    const content = `
Route::middleware(['auth'])->prefix('api/v1')->group(function () {
    Route::delete('/users/{id}', [UserController::class, 'destroy']);
});`;
    const routes = extractLaravelRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/api/v1/users/[id]');
    expect(routes[0].httpMethod).toBe('DELETE');
  });

  it('returns empty array for empty content', () => {
    expect(extractLaravelRoutes('', FILE)).toHaveLength(0);
  });
});

// ── Fiber (Go) camelCase routes ─────────────────────────────────────────────

describe('isGinRouteFile', () => {
  it('detects Gin uppercase .GET pattern', () => {
    expect(isGinRouteFile('r.GET("/users", handler)')).toBe(true);
  });

  it('detects Fiber camelCase .Get pattern', () => {
    expect(isGinRouteFile('app.Get("/users", handler)')).toBe(true);
  });

  it('detects Fiber .Post pattern', () => {
    expect(isGinRouteFile('app.Post("/users", createUser)')).toBe(true);
  });

  it('rejects non-route Go files', () => {
    expect(isGinRouteFile('func main() {}')).toBe(false);
  });
});

describe('extractGinRoutes — Fiber camelCase', () => {
  const FILE = 'routes.go';

  it('extracts Fiber app.Get route', () => {
    const content = `app.Get("/users", listUsers)`;
    const routes = extractGinRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].routePath).toBe('/users');
    expect(routes[0].httpMethod).toBe('GET');
  });

  it('extracts Fiber app.Post route', () => {
    const content = `app.Post("/users", createUser)`;
    const routes = extractGinRoutes(content, FILE);
    expect(routes).toHaveLength(1);
    expect(routes[0].httpMethod).toBe('POST');
  });

  it('extracts Fiber app.Put and app.Delete routes', () => {
    const content = `
app.Put("/users/:id", updateUser)
app.Delete("/users/:id", deleteUser)`;
    const routes = extractGinRoutes(content, FILE);
    expect(routes).toHaveLength(2);
    expect(routes.find((r) => r.httpMethod === 'PUT')).toBeDefined();
    expect(routes.find((r) => r.httpMethod === 'DELETE')).toBeDefined();
  });

  it('normalizes Fiber path params :id to [id]', () => {
    const content = `app.Get("/users/:id", getUser)`;
    const routes = extractGinRoutes(content, FILE);
    expect(routes[0].routePath).toBe('/users/[id]');
  });

  it('extracts mixed Gin uppercase and Fiber camelCase from same file', () => {
    const content = `
r.GET("/ping", ping)
app.Get("/users", listUsers)
r.POST("/users", createUser)
app.Post("/orders", createOrder)`;
    const routes = extractGinRoutes(content, FILE);
    expect(routes).toHaveLength(4);
  });

  it('returns empty array for empty content', () => {
    expect(extractGinRoutes('', FILE)).toHaveLength(0);
  });

  it('sets filePath on all routes', () => {
    const content = `app.Get("/health", healthCheck)`;
    const routes = extractGinRoutes(content, FILE);
    expect(routes.every((r) => r.filePath === FILE)).toBe(true);
  });
});
