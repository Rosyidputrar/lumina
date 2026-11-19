/**
 * The one way the app talks to the backend.
 *
 * - Same origin by default; VITE_API_BASE points at a backend elsewhere.
 * - Cookies carry the session (HttpOnly), so every call sends credentials and
 *   nothing secret ever lives in JavaScript.
 * - Errors become ApiError with the backend's status, machine code and message,
 *   so screens can react to a code instead of parsing prose.
 */

export const API_BASE: string = (import.meta.env.VITE_API_BASE ?? '').replace(/\/+$/, '');

export class ApiError extends Error {
  status: number;
  code: string;
  details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  get reasons(): string[] {
    const r = this.details.reasons;
    return Array.isArray(r) ? r.map(String) : [];
  }
}

/** Codes that mean "this device is not (or no longer) allowed in". */
export const SESSION_CODES = new Set(['NOT_ACTIVATED', 'LICENCE_EXPIRED', 'LICENCE_REVOKED', 'LICENCE_INVALID', 'LICENCE_UNKNOWN', 'LICENCE_MALFORMED']);

type Listener = (err: ApiError) => void;
const sessionListeners = new Set<Listener>();

/** The session provider subscribes here to drop back to the activation screen. */
export function onSessionLost(fn: Listener): () => void {
  sessionListeners.add(fn);
  return () => sessionListeners.delete(fn);
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  signal?: AbortSignal;
  /** Raw body (file upload). Sent as-is with application/octet-stream. */
  raw?: Blob | ArrayBuffer;
  /** Do not broadcast a lost session (used by the boot probe itself). */
  quiet?: boolean;
}

export function url(path: string, query?: RequestOptions['query']): string {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(query ?? {})) {
    if (v === undefined || v === null || v === '') continue;
    qs.set(k, String(v));
  }
  const q = qs.toString();
  return `${API_BASE}${path}${q ? `?${q}` : ''}`;
}

export function humanMessage(status: number, code: string, message: string): string {
  if (status === 0) return 'The server could not be reached. Check your connection and try again.';
  if (status === 429) return message || 'Too many requests. Wait a moment and try again.';
  if (status >= 500 && (!message || message === 'internal error')) return 'The server hit an error. Try again in a moment.';
  if (!message) return `Request failed (${status}${code ? `, ${code}` : ''}).`;
  // Backend messages are written in lower case for logs; present them as sentences.
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export async function request<T = unknown>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = opts.method ?? (opts.body !== undefined || opts.raw !== undefined ? 'POST' : 'GET');
  const headers: Record<string, string> = { accept: 'application/json' };
  let body: BodyInit | undefined;
  if (opts.raw !== undefined) {
    body = opts.raw;
    headers['content-type'] = 'application/octet-stream';
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers['content-type'] = 'application/json';
  } else if (method !== 'GET') {
    body = '{}';
    headers['content-type'] = 'application/json';
  }

  let res: Response;
  try {
    res = await fetch(url(path, opts.query), { method, headers, body, credentials: 'include', signal: opts.signal });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') throw e;
    throw new ApiError(0, 'NETWORK', humanMessage(0, 'NETWORK', ''));
  }

  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }

  if (!res.ok) {
    const obj = (data ?? {}) as Record<string, unknown>;
    const code = String(obj.code ?? 'HTTP_' + res.status);
    const err = new ApiError(res.status, code, humanMessage(res.status, code, String(obj.error ?? '')), obj);
    if (!opts.quiet && SESSION_CODES.has(code)) for (const fn of sessionListeners) fn(err);
    throw err;
  }
  return data as T;
}

export const api = {
  get: <T>(path: string, query?: RequestOptions['query'], signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body: body ?? {} }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body: body ?? {} }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

/** Describe any thrown value for a toast or inline error. */
export function errorText(e: unknown): string {
  if (e instanceof ApiError) {
    const reasons = e.reasons;
    if (e.code === 'RISK_REJECTED' && reasons.length) return `The risk gate refused this order: ${reasons.join('; ')}.`;
    return e.message;
  }
  if (e instanceof Error) return e.message;
  return 'Something went wrong.';
}

/** Upload a file with progress. fetch has no upload progress, so this uses XHR. */
export function upload(path: string, file: File, query: Record<string, string>, onProgress?: (fraction: number) => void): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', url(path, query));
    xhr.withCredentials = true;
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (ev) => {
      if (ev.lengthComputable) onProgress?.(ev.loaded / ev.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'NETWORK', humanMessage(0, 'NETWORK', '')));
    xhr.onload = () => {
      let data: Record<string, unknown> = {};
      try {
        data = JSON.parse(xhr.responseText || '{}');
      } catch {
        /* not json */
      }
      if (xhr.status >= 200 && xhr.status < 300) resolve(data);
      else {
        const code = String(data.code ?? 'HTTP_' + xhr.status);
        reject(new ApiError(xhr.status, code, humanMessage(xhr.status, code, String(data.error ?? '')), data));
      }
    };
    xhr.send(file);
  });
}
