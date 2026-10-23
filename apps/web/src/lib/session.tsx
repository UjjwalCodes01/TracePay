import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { ApiError, api, forgetDemo, getDemoUserId, getDemoWorld, isFirstVisit, post, retryWhileWaking, setDemoUserId, setDemoWorld, wakingRetryDelay } from './api';
import type { AppConfig, DemoUser } from './types';

type AuthMethod = 'session' | 'api_key' | 'demo';

interface Session {
  /** The signed-in (or demo) user; null when nobody is signed in. */
  user: DemoUser | null;
  authMethod: AuthMethod | null;
  loading: boolean;
  /** Who-am-I failed for a reason other than "not signed in" (server down, rate limited…). */
  error: unknown;
  retry: () => void;
  /** Seeded demo users — empty unless the server runs in demo mode. */
  users: DemoUser[];
  config: AppConfig | null;
  switchUser: (id: string) => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; name: string; role: 'publisher' | 'contributor' | 'buyer'; paypalEmail?: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const waking = { retry: retryWhileWaking, retryDelay: wakingRetryDelay };
  const config = useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/config'), staleTime: Infinity, ...waking });
  // A first visit to the demo gets a private copy of it (no other visitor can see or reset it).
  // If one can't be made (rate limited, an old server), the shared demo is used instead.
  const needsWorld = !!config.data?.demoMode && isFirstVisit() && !getDemoWorld();
  const world = useQuery({
    queryKey: ['demo-world'],
    queryFn: async () => {
      try {
        const w = await post<{ token: string; publisherId: string }>('/demo/worlds');
        setDemoWorld(w.token);
        setDemoUserId(w.publisherId);
      } catch (e) {
        if (e instanceof ApiError && (e.status === 0 || e.status >= 502)) throw e; // still waking: try again
        setDemoUserId(getDemoUserId());
      }
      return true;
    },
    enabled: needsWorld,
    staleTime: Infinity,
    ...waking,
  });
  const worldSettled = !config.isPending && (!needsWorld || world.isFetched);
  const users = useQuery({ queryKey: ['demo-users'], queryFn: () => api<{ users: DemoUser[] }>('/demo/users'), enabled: worldSettled, ...waking });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<{ user: DemoUser; authMethod: AuthMethod }>('/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) {
          // This browser's private world is gone (the demo was rebuilt): start again with a fresh one.
          if (getDemoUserId()?.startsWith('dw_')) {
            forgetDemo();
            window.location.reload();
          }
          return null;
        }
        throw e;
      }
    },
    enabled: worldSettled,
    ...waking,
  });

  // Every other query belongs to the acting user: drop them when the user changes.
  const resetUserData = useCallback(async () => {
    qc.removeQueries({ predicate: (q) => !['demo-users', 'config', 'me'].includes(String(q.queryKey[0])) });
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);

  const switchUser = useCallback(
    async (id: string) => {
      setDemoUserId(id);
      await resetUserData();
    },
    [resetUserData],
  );

  const signIn = useCallback(
    async (email: string, password: string) => {
      await post('/auth/login', { email, password });
      setDemoUserId(null);
      await resetUserData();
    },
    [resetUserData],
  );

  const signUp = useCallback<Session['signUp']>(
    async (input) => {
      await post('/auth/signup', input);
      setDemoUserId(null);
      await resetUserData();
    },
    [resetUserData],
  );

  const signOut = useCallback(async () => {
    await post('/auth/logout');
    setDemoUserId(null);
    await resetUserData();
  }, [resetUserData]);

  const value = useMemo<Session>(
    () => ({
      user: me.data?.user ?? null,
      authMethod: me.data?.authMethod ?? null,
      loading: me.isPending || config.isLoading,
      error: me.data === undefined ? me.error : null,
      retry: () => void me.refetch(),
      users: users.data?.users ?? [],
      config: config.data ?? null,
      switchUser,
      signIn,
      signUp,
      signOut,
    }),
    [me.data, me.isLoading, me.error, me.refetch, config.data, config.isLoading, users.data, switchUser, signIn, signUp, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
