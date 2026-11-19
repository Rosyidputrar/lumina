import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import { api, url } from './api';
import type { Quote, Terminal } from './types';

/** Query keys in one place so invalidation never misses a screen. */
export const keys = {
  licence: ['licence'] as const,
  ownerSession: ['owner', 'session'] as const,
  terminal: ['terminal'] as const,
  positions: ['positions'] as const,
  pending: ['pending-orders'] as const,
  journal: ['journal'] as const,
  analysis: (venue: string, symbol: string, tf: string) => ['analysis', venue, symbol, tf] as const,
  explain: (venue: string, symbol: string, tf: string) => ['explain', venue, symbol, tf] as const,
  sweep: (tf: string, pattern: string, profitOnly: boolean, minRR: number) => ['sweep', tf, pattern, profitOnly, minRR] as const,
  messages: ['ai', 'messages'] as const,
  aiStatus: ['ai', 'status'] as const,
  watcher: ['ai', 'watcher'] as const,
  vault: ['vault'] as const,
  note: (id: string) => ['vault', 'note', id] as const,
  vaultSearch: (q: string) => ['vault', 'search', q] as const,
  memory: ['memory'] as const,
  files: ['files'] as const,
  news: ['news'] as const,
  preferences: ['preferences'] as const,
  broker: ['broker'] as const,
  system: ['system'] as const,
  owner: (part: string) => ['owner', part] as const,
};

/** Everything trading-related that changes when the book changes. */
export function invalidateBook(qc: QueryClient) {
  qc.invalidateQueries({ queryKey: keys.terminal });
  qc.invalidateQueries({ queryKey: keys.positions });
  qc.invalidateQueries({ queryKey: keys.pending });
  qc.invalidateQueries({ queryKey: keys.journal });
}

export function useTerminal() {
  return useQuery({
    queryKey: keys.terminal,
    queryFn: ({ signal }) => api.get<Terminal>('/api/terminal', undefined, signal),
    refetchInterval: 20_000,
    staleTime: 5_000,
  });
}

export type StreamState = 'connecting' | 'live' | 'offline';

/**
 * Server-sent events from /api/stream.
 *
 * Quotes patch the cached terminal in place (no refetch per tick). Book events
 * (positions, cycles, signals) invalidate, debounced, so a burst of fills costs
 * one round trip. EventSource reconnects by itself; the state is surfaced so
 * the header can say whether prices are live.
 */
export function useLiveStream(enabled: boolean): StreamState {
  const qc = useQueryClient();
  const [state, setState] = useState<StreamState>('connecting');
  const timer = useRef<number | null>(null);

  useEffect(() => {
    if (!enabled || typeof EventSource === 'undefined') return;
    const es = new EventSource(url('/api/stream'), { withCredentials: true });
    const refresh = () => {
      if (timer.current) window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => invalidateBook(qc), 600);
    };

    es.addEventListener('hello', () => setState('live'));
    es.addEventListener('ping', () => setState('live'));
    es.onerror = () => setState(es.readyState === EventSource.CLOSED ? 'offline' : 'connecting');

    es.addEventListener('quote', (ev) => {
      try {
        const q = (JSON.parse((ev as MessageEvent).data).payload ?? null) as Quote | null;
        if (!q?.symbol) return;
        qc.setQueryData<Terminal>(keys.terminal, (old) => {
          if (!old) return old;
          const quotes = old.quotes.some((x) => x.symbol === q.symbol) ? old.quotes.map((x) => (x.symbol === q.symbol ? q : x)) : old.quotes;
          return { ...old, quotes };
        });
      } catch {
        /* a malformed event is ignored */
      }
    });
    for (const type of ['position', 'cycle', 'signal', 'equity']) es.addEventListener(type, refresh);
    es.addEventListener('vault', () => qc.invalidateQueries({ queryKey: keys.vault }));
    es.addEventListener('news', () => qc.invalidateQueries({ queryKey: keys.news }));

    return () => {
      es.close();
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [enabled, qc]);

  return enabled ? state : 'offline';
}

/** Re-render every `ms` so relative times ("2 min ago") stay true. */
export function useNow(ms = 15_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), ms);
    return () => window.clearInterval(id);
  }, [ms]);
  return now;
}

/** A value that only settles after the user stops typing. */
export function useDebounced<T>(value: T, ms = 300): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(id);
  }, [value, ms]);
  return v;
}
