// Empty in production too: Vercel rewrites /api/* to the API, so cookies stay first-party.
const BASE = (import.meta.env.VITE_API_BASE_URL as string | undefined)?.replace(/\/$/, '') ?? '';

const USER_KEY = 'tracepay.demoUser';
const WORLD_KEY = 'tracepay.demoWorld';

/** This browser's private demo world ("<world>.<secret>"), if it has one. */
export function getDemoWorld(): string | null {
  try {
    return localStorage.getItem(WORLD_KEY) || null;
  } catch {
    return null;
  }
}

export function setDemoWorld(token: string | null) {
  try {
    if (token) localStorage.setItem(WORLD_KEY, token);
    else localStorage.removeItem(WORLD_KEY);
  } catch {
    // Storage unavailable: this tab uses the shared demo.
  }
}

/** Forgets this browser's demo world and role: the next load starts like a first visit. */
export function forgetDemo() {
  try {
    localStorage.removeItem(WORLD_KEY);
    localStorage.removeItem(USER_KEY);
  } catch {
    // Storage unavailable: nothing was kept.
  }
}

/** A first visit: no demo role chosen yet (and not signed out on purpose). */
export function isFirstVisit(): boolean {
  try {
    return localStorage.getItem(USER_KEY) === null;
  } catch {
    return false;
  }
}

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

const SERVER_UNAVAILABLE = 'TracePay’s server isn’t responding right now (it may be waking up). Try again in a minute.';

/** "Too small: expected string to have >=10 characters" on "goal" → "Goal: too short (at least 10 characters)." */
function readable(issue: { message: string; path?: unknown[] }): string {
  const field = Array.isArray(issue.path) && issue.path.length ? String(issue.path.at(-1)) : null;
  const label = field ? `${field.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())}: ` : '';
  const min = issue.message.match(/Too small: expected string to have >=(\d+) characters?/);
  const max = issue.message.match(/Too big: expected string to have <=(\d+) characters?/);
  const text = min ? `too short (at least ${min[1]} characters)` : max ? `too long (at most ${max[1]} characters)` : issue.message.replace(/^./, (c) => c.toLowerCase());
  return `${label}${text.replace(/^./, (c) => (label ? c : c.toUpperCase()))}${/[.!?]$/.test(text) ? '' : '.'}`;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const demoUser = getDemoUserId();
  const demoWorld = getDemoWorld();
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      credentials: 'include',
      headers: {
        ...(demoUser ? { 'X-Demo-User': demoUser } : {}),
        ...(demoWorld ? { 'X-Demo-World': demoWorld } : {}),
        ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  } catch {
    // The browser's own wording ("Failed to fetch", "NetworkError when…") means nothing to people.
    throw new ApiError(0, 'Can’t reach TracePay. Check your internet connection, then try again.');
  }
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    // Not JSON: an HTML error page from the hosting platform (502/504 while the API wakes up), not from TracePay.
    throw new ApiError(res.status, res.ok ? 'TracePay sent an unexpected response. Please try again.' : SERVER_UNAVAILABLE);
  }
  if (!res.ok && !(res.status === 422 && path.endsWith('/generate') && !path.startsWith('/v1/'))) {
    // Dashboard routes answer { error: "…", details }; the platform API (/v1) answers
    // { error: { message, code, details }, request_id }.
    const envelope = data?.error && typeof data.error === 'object' ? data.error : null;
    const details = envelope ? envelope.details : data?.details;
    const message: string = envelope?.message ?? data?.error ?? (res.status >= 502 ? SERVER_UNAVAILABLE : `Request failed (${res.status})`);
    // A validation failure: show its first message on its own, in plain words (the v1 message already includes it).
    const first = !envelope && Array.isArray(details) && details[0]?.message ? readable(details[0]) : null;
    throw new ApiError(res.status, first ?? message, details);
  }
  return data as T;
}

/** The server is asleep, waking or unreachable (not a TracePay answer): worth retrying for a while. */
export const isUnavailable = (e: unknown) => e instanceof ApiError && (e.status === 0 || e.status >= 502);

/** Retry policy for the queries a page can't start without: ride out a cold start (~1 minute). */
export const retryWhileWaking = (failures: number, e: unknown) => (isUnavailable(e) ? failures < 8 : failures < 1);
export const wakingRetryDelay = (attempt: number) => Math.min(8000, 1000 * 2 ** attempt);

export const post = <T>(path: string, body: unknown = {}) => api<T>(path, { method: 'POST', body });
export const del = <T>(path: string) => api<T>(path, { method: 'DELETE' });
export const patch = <T>(path: string, body: unknown) => api<T>(path, { method: 'PATCH', body });
