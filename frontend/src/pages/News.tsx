import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ExternalLink, Newspaper, RefreshCw } from 'lucide-react';
import { api } from '../lib/api';
import { keys } from '../lib/queries';
import { ago, dateTime } from '../lib/format';
import type { NewsItem } from '../lib/types';
import { Button, Card, Empty, ErrorState, LoadingRows, Notice } from '../components/ui';

export function News() {
  const qc = useQueryClient();
  const news = useQuery({ queryKey: keys.news, queryFn: () => api.get<{ items: NewsItem[]; configured: boolean; error: string | null; source: string | null; at?: number }>('/api/news'), refetchInterval: 120_000 });
  const reload = async () => {
    const fresh = await api.get('/api/news', { force: 1 });
    qc.setQueryData(keys.news, fresh);
  };
  if (news.isLoading) return <LoadingRows rows={6} label="Loading news" />;
  if (news.isError) return <ErrorState error={news.error} onRetry={() => news.refetch()} />;
  const n = news.data!;
  return (
    <>
      <div className="page-head">
        <div>
          <h2>Market news</h2>
          <p>Headlines from the feed the owner configured. The analyst reads the same headlines when it answers.</p>
        </div>
        {n.configured ? (
          <Button onClick={reload}>
            <RefreshCw aria-hidden="true" /> Refresh
          </Button>
        ) : null}
      </div>
      {n.error ? <Notice kind="warn" title="The feed could not be read">{n.error}. Showing the last headlines that loaded.</Notice> : null}
      <Card title="Headlines" meta={n.configured ? `${n.items.length} items${n.at ? ` · fetched ${ago(n.at)}` : ''}` : undefined} bodyClass="flush">
        {!n.configured ? (
          <Empty icon={Newspaper} title="No news feed is configured">
            Lumina never invents headlines. The owner can point NEWS_FEED_URL at any RSS, Atom or JSON feed on the server.
          </Empty>
        ) : n.items.length ? (
          <ul className="list">
            {n.items.map((it, i) => (
              <li key={`${it.title}-${i}`} className="stack-sm" style={{ gap: 4 }}>
                {it.url ? (
                  <a className="row" href={it.url} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none', gap: 6, fontWeight: 500, flexWrap: 'nowrap', alignItems: 'flex-start' }}>
                    {it.title}
                    <ExternalLink aria-hidden="true" style={{ width: 14, height: 14, flex: 'none', marginTop: 4, color: 'var(--muted)' }} />
                  </a>
                ) : (
                  <strong style={{ fontWeight: 500 }}>{it.title}</strong>
                )}
                {it.summary ? <p className="small" style={{ color: 'var(--ink-2)' }}>{it.summary}</p> : null}
                <span className="small muted">{[it.source, it.ts ? dateTime(it.ts) : null].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty icon={Newspaper} title="The feed is empty" />
        )}
      </Card>
    </>
  );
}
