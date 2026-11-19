import { createContext, useCallback, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, onSessionLost, request } from '../lib/api';
import { keys } from '../lib/queries';
import type { LicenceStatus } from '../lib/types';

interface Session {
  loading: boolean;
  /** The probe itself failed (server down): not the same as "not activated". */
  error: Error | null;
  active: boolean;
  owner: boolean;
  status: LicenceStatus | null;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const licence = useQuery({
    queryKey: keys.licence,
    queryFn: () => request<LicenceStatus>('/api/licence', { quiet: true }),
    staleTime: 60_000,
    retry: 1,
  });

  const refresh = useCallback(async () => {
    await qc.invalidateQueries({ queryKey: keys.licence });
    await qc.refetchQueries({ queryKey: keys.licence });
  }, [qc]);

  // Any call that comes back "not activated / revoked / expired" sends the app
  // back to the activation screen instead of leaving broken screens behind.
  useEffect(
    () =>
      onSessionLost(() => {
        qc.setQueryData<LicenceStatus>(keys.licence, (old) => ({ ...(old ?? { licence: null }), active: false, owner: false }));
      }),
    [qc],
  );

  const signOut = useCallback(async () => {
    const owner = licence.data?.owner;
    await Promise.allSettled([api.post('/api/licence/deactivate'), owner ? api.post('/api/owner/logout') : Promise.resolve()]);
    qc.clear();
    await refresh();
  }, [licence.data?.owner, qc, refresh]);

  const value = useMemo<Session>(
    () => ({
      loading: licence.isLoading,
      error: licence.isError ? (licence.error as Error) : null,
      active: Boolean(licence.data?.active),
      owner: Boolean(licence.data?.owner),
      status: licence.data ?? null,
      refresh,
      signOut,
    }),
    [licence.isLoading, licence.isError, licence.error, licence.data, refresh, signOut],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useSession(): Session {
  const s = useContext(Ctx);
  if (!s) throw new Error('useSession outside SessionProvider');
  return s;
}
