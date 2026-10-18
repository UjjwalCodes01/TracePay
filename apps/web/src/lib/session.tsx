import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, type ReactNode } from 'react';
import { ApiError, api, post, setDemoUserId } from './api';
import type { AppConfig, DemoUser } from './types';

type AuthMethod = 'session' | 'api_key' | 'demo';

interface Session {
  /** The signed-in (or demo) user; null when nobody is signed in. */
  user: DemoUser | null;
  authMethod: AuthMethod | null;
  loading: boolean;
  /** Seeded demo users — empty unless the server runs in demo mode. */
  users: DemoUser[];
  config: AppConfig | null;
  switchUser: (id: string) => void;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; name: string; role: 'publisher' | 'contributor' | 'buyer'; paypalEmail?: string }) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const config = useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/config'), staleTime: Infinity });
  const users = useQuery({ queryKey: ['demo-users'], queryFn: () => api<{ users: DemoUser[] }>('/demo/users') });
  const me = useQuery({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<{ user: DemoUser; authMethod: AuthMethod }>('/me');
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
  });

  // Every other query belongs to the acting user: drop them when the user changes.
  const resetUserData = useCallback(async () => {
    qc.removeQueries({ predicate: (q) => !['demo-users', 'config', 'me'].includes(String(q.queryKey[0])) });
    await qc.invalidateQueries({ queryKey: ['me'] });
  }, [qc]);

  const switchUser = useCallback(
    (id: string) => {
      setDemoUserId(id);
      void resetUserData();
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
      loading: me.isLoading || config.isLoading,
      users: users.data?.users ?? [],
      config: config.data ?? null,
      switchUser,
      signIn,
      signUp,
      signOut,
    }),
    [me.data, me.isLoading, config.data, config.isLoading, users.data, switchUser, signIn, signUp, signOut],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
