import { useQuery, useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { api, getDemoUserId, setDemoUserId } from './api';
import type { AppConfig, DemoUser } from './types';

interface Session {
  user: DemoUser | null;
  users: DemoUser[];
  config: AppConfig | null;
  switchUser: (id: string) => void;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const [userId, setUserId] = useState(getDemoUserId);
  const users = useQuery({ queryKey: ['demo-users'], queryFn: () => api<{ users: DemoUser[] }>('/demo/users') });
  const config = useQuery({ queryKey: ['config'], queryFn: () => api<AppConfig>('/config'), staleTime: Infinity });

  const switchUser = useCallback(
    (id: string) => {
      setDemoUserId(id);
      setUserId(id);
      // Every query is scoped by the acting user.
      qc.removeQueries({ predicate: (q) => !['demo-users', 'config'].includes(String(q.queryKey[0])) });
    },
    [qc],
  );

  const value = useMemo<Session>(
    () => ({
      user: users.data?.users.find((u) => u.id === userId) ?? null,
      users: users.data?.users ?? [],
      config: config.data ?? null,
      switchUser,
    }),
    [users.data, config.data, userId, switchUser],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
