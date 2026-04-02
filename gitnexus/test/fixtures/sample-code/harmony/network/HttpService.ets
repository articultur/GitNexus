/**
 * HarmonyOS HTTP service — demonstrates ArkTS network APIs.
 * Exercises: http.createHttp().request(), error handling, response parsing.
 */
import http from '@ohos.net.http';
import hilog from '@ohos.hilog';

const TAG = 'HttpService';
const BASE_URL = 'https://api.example.com';

export interface ApiResponse<T> {
  code: number;
  message: string;
  data: T;
}

export interface FetchOptions {
  path: string;
  method?: http.RequestMethod;
  body?: string;
}

export async function fetchJson<T>(options: FetchOptions): Promise<T> {
  const client = http.createHttp();
  try {
    const response = await client.request(`${BASE_URL}${options.path}`, {
      method: options.method ?? http.RequestMethod.GET,
      header: { 'Content-Type': 'application/json' },
      extraData: options.body,
      connectTimeout: 10000,
      readTimeout: 15000,
    });

    if (response.responseCode !== 200) {
      throw new Error(`HTTP ${response.responseCode}: ${options.path}`);
    }

    const parsed: ApiResponse<T> = JSON.parse(response.result as string);
    if (parsed.code !== 0) {
      throw new Error(`API error ${parsed.code}: ${parsed.message}`);
    }
    return parsed.data;
  } finally {
    client.destroy();
  }
}

export async function fetchProducts(category: string): Promise<{ id: number; name: string; price: number }[]> {
  const safeCat = encodeURIComponent(category);
  return fetchJson({ path: `/products?category=${safeCat}` });
}

export function logRequest(url: string, method: string): void {
  hilog.info(0x0000, TAG, `Request: %{public}s %{public}s`, method, url);
}
