// Empty in production too: Vercel rewrites /api/* to the API, so cookies stay first-party.
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const USER_KEY = 'tracepay.demoUser';

/** The demo role chosen in the switcher. The server ignores it unless DEMO_MODE is on. */
export function getDemoUserId(): string | null {
  try {
    const v = localStorage.getItem(USER_KEY);
    // First visit: start as the demo publisher. An empty value means "signed out".
    return v === null ? 'user_atlas' : v || null;
  } catch {
    return 'user_atlas';
  }
}

export function setDemoUserId(id: string | null) {
  try {
    localStorage.setItem(USER_KEY, id ?? '');
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

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const demoUser = getDemoUserId();
  const res = await fetch(`${BASE}/api${path}`, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    credentials: 'include',
    headers: {
      ...(demoUser ? { 'X-Demo-User': demoUser } : {}),
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok && !(res.status === 422 && path.endsWith('/generate') && !path.startsWith('/v1/'))) {
    // Dashboard routes answer { error: "…", details }; the platform API (/v1) answers
    // { error: { message, code, details }, request_id }.
    const envelope = data?.error && typeof data.error === 'object' ? data.error : null;
    const details = envelope ? envelope.details : data?.details;
    const message: string = envelope?.message ?? data?.error ?? `Request failed (${res.status})`;
    // Surface the first validation message in plain words (the v1 message already includes it).
    const first = !envelope && Array.isArray(details) && details[0]?.message ? `: ${details[0].message}` : '';
    throw new ApiError(res.status, `${message}${first}`, details);
  }
  return data as T;
}

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
