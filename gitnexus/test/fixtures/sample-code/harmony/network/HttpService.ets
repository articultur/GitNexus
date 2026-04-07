/**
 * HttpService fixture — HarmonyOS network utilities.
 * Used by tree-sitter-languages.test.ts for exported function extraction tests.
 */

import http from '@ohos.net.http';

export async function logRequest(url: string, method: string): Promise<void> {
  console.info(`[HTTP] ${method} ${url}`);
}

export async function fetchJson<T>(url: string): Promise<T> {
  await logRequest(url, 'GET');
  const httpRequest = http.createHttp();
  const response = await httpRequest.request(url, {
    method: http.RequestMethod.GET,
    header: { 'Content-Type': 'application/json' },
  });
  httpRequest.destroy();
  return JSON.parse(response.result as string) as T;
}

export async function fetchProducts(): Promise<object[]> {
  return fetchJson<object[]>('https://api.example.com/products');
}
