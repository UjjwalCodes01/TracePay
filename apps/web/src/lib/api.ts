const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const USER_KEY = 'tracepay.demoUser';

export function getDemoUserId(): string {
  try {
    return localStorage.getItem(USER_KEY) ?? 'user_atlas';
  } catch {
    return 'user_atlas';
  }
}

export function setDemoUserId(id: string) {
  try {
    localStorage.setItem(USER_KEY, id);
  } catch {
    // Storage unavailable (private mode): the session still works for this tab.
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; userId?: string } = {}): Promise<T> {
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers: {
      'X-Demo-User': init.userId ?? getDemoUserId(),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && !(res.status === 422 && path.endsWith('/generate'))) {
    throw new ApiError(res.status, data?.error ?? `Request failed (${res.status})`, data?.details);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
