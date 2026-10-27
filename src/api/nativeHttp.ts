import { Capacitor, CapacitorHttp } from '@capacitor/core';

export function useNativeHttp(): boolean {
  return Capacitor.isNativePlatform();
}

export interface NativeHttpResponse {
  status: number;
  headers: Record<string, string>;
  data: string;
  url: string;
}

/**
 * 原生 HTTP（绕过 WebView CORS）。仅用于 Android/iOS；Web 仍走 fetch。
 * 注意：原生层一次返回完整响应，不支持真正的 SSE 流式读取。
 */
export async function nativeHttpRequest(
  url: string,
  init: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    signal?: AbortSignal;
  } = {},
): Promise<NativeHttpResponse> {
  if (init.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const method = (init.method || 'GET').toUpperCase();
  const headers: Record<string, string> = { ...(init.headers || {}) };

  let data: string | Record<string, unknown> | undefined;
  if (init.body != null && method !== 'GET' && method !== 'HEAD') {
    const ct = Object.keys(headers).find((k) => k.toLowerCase() === 'content-type');
    const isJson = ct ? /json/i.test(headers[ct]) : false;
    if (isJson) {
      try {
        data = JSON.parse(init.body) as Record<string, unknown>;
      } catch {
        data = init.body;
      }
    } else {
      data = init.body;
    }
  }

  const res = await CapacitorHttp.request({
    url,
    method,
    headers,
    data,
    responseType: 'text',
  });

  if (init.signal?.aborted) {
    throw new DOMException('Aborted', 'AbortError');
  }

  const raw = res.data;
  const text =
    typeof raw === 'string'
      ? raw
      : raw == null
        ? ''
        : typeof raw === 'object'
          ? JSON.stringify(raw)
          : String(raw);

  const hdrs: Record<string, string> = {};
  if (res.headers && typeof res.headers === 'object') {
    for (const [k, v] of Object.entries(res.headers)) {
      hdrs[k] = String(v);
    }
  }

  return {
    status: res.status,
    headers: hdrs,
    data: text,
    url,
  };
}

/** 把原生响应包装成接近 fetch Response 的只读对象（供非流式路径复用） */
export function nativeToFetchResponse(res: NativeHttpResponse): Response {
  return new Response(res.data, {
    status: res.status,
    headers: res.headers,
  });
}
