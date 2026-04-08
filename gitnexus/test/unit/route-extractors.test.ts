/**
 * Unit tests for Django and Rails route extractors.
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
