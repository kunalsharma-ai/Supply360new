import type { Problem } from '@s360/contracts';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Partial<Problem>,
  ) {
    super(problem.detail ?? problem.title ?? `HTTP ${status}`);
  }
}

/** Same-origin calls to the API (proxied by Next). Writes carry the CSRF header the API requires. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  const res = await fetch(`/api/v1${path}`, {
    method,
    credentials: 'same-origin',
    headers: {
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(method !== 'GET' ? { 'x-s360-csrf': '1' } : {}),
    },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data as Partial<Problem>);
  return data as T;
}
