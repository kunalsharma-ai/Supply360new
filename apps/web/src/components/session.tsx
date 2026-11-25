'use client';
import type { Me, Permission } from '@s360/contracts';
import { useQuery } from '@tanstack/react-query';
import { usePathname, useRouter } from 'next/navigation';
import { createContext, useContext, useEffect, type ReactNode } from 'react';
import { api, ApiError } from '@/lib/api';
import { Loading } from './ui/states';

const SessionCtx = createContext<Me | null>(null);

export function useSession(): Me {
  const s = useContext(SessionCtx);
  if (!s) throw new Error('useSession outside SessionGate');
  return s;
}
export function useCan(p: Permission): boolean {
  return useSession().permissions.includes(p);
}

/** Loads /auth/me; on 401 sends the person to sign in and comes back afterwards. */
export function SessionGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  const q = useQuery({ queryKey: ['me'], queryFn: () => api<Me>('/auth/me'), retry: false });
  const unauth = q.error instanceof ApiError && q.error.status === 401;
  useEffect(() => {
    if (unauth) router.replace(`/login?next=${encodeURIComponent(path)}`);
  }, [unauth, router, path]);
  if (q.data) return <SessionCtx.Provider value={q.data}>{children}</SessionCtx.Provider>;
  if (q.error && !unauth)
    return (
      <div className="grid min-h-screen place-items-center p-6 text-center text-sm text-muted">
        The Supply360 API is not reachable. Check that it is running, then reload.
      </div>
    );
  return <Loading label="Checking your session" />;
}
