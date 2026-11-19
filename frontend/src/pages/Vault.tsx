import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Plus, Search, Trash2 } from 'lucide-react';
import { api, errorText } from '../lib/api';
import { keys, useDebounced } from '../lib/queries';
import { ago, bytes, num } from '../lib/format';
import type { VaultNote, VaultNoteSummary, VaultSnapshot } from '../lib/types';
import { Badge, Button, Card, ConfirmDialog, Dialog, Empty, ErrorState, Field, LoadingRows, Notice, fieldProps } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { useToast } from '../components/Toast';

export function Vault() {
  const qc = useQueryClient();
  const toast = useToast();
  const [selected, setSelected] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [creating, setCreating] = useState(false);
  const q = useDebounced(query.trim(), 250);
  const snap = useQuery({ queryKey: keys.vault, queryFn: () => api.get<VaultSnapshot>('/api/vault') });
  const search = useQuery({
    queryKey: keys.vaultSearch(q),
    queryFn: () => api.get<{ results: (VaultNoteSummary & { excerpt?: string; score?: number })[] }>('/api/vault/search', { q, limit: 30 }),
    enabled: q.length >= 2,
  });
  const memory = useQuery({ queryKey: keys.memory, queryFn: () => api.get<{ stats: { episodes: number; capacity: number; lastConsolidation: number } }>('/api/memory') });
  const consolidate = useMutation({
    mutationFn: () => api.post<{ result: { written: number; episodes: number } }>('/api/memory/consolidate'),
    onSuccess: (r) => {
      toast.success('Memory consolidated', r.result.written ? `${r.result.written} note${r.result.written === 1 ? '' : 's'} written from ${r.result.episodes} episodes.` : 'Nothing new to fold into the vault yet.');
      qc.invalidateQueries({ queryKey: keys.vault });
      qc.invalidateQueries({ queryKey: keys.memory });
    },
    onError: (e) => toast.error('Consolidation did not run', errorText(e)),
  });

  const notes = useMemo(() => {
    const all = snap.data?.notes ?? [];
    if (q.length >= 2) return search.data?.results ?? [];
    return tag ? all.filter((n) => n.tags.includes(tag)) : all;
  }, [snap.data, search.data, q, tag]);

  const openByTitle = (title: string) => {
    const hit = snap.data?.notes.find((n) => n.title.toLowerCase() === title.toLowerCase() || n.path.toLowerCase().endsWith(`/${title.toLowerCase()}.md`));
    if (hit) setSelected(hit.id);
    else {
      setQuery(title);
      toast.info(`No note named “${title}”`, 'Showing search results instead.');
    }
  };

  if (snap.isLoading) return <LoadingRows rows={8} label="Loading the vault" />;
  if (snap.isError) return <ErrorState error={snap.error} onRetry={() => snap.refetch()} />;
  const s = snap.data!.stats;

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Research vault</h2>
          <p>Linked notes the engine and traders share: concepts, playbooks and an anonymous lesson for every closed trade. It lives in server memory, capped at {num(s.limits.maxNotes)} notes.</p>
        </div>
        <div className="page-actions">
          <Button onClick={() => consolidate.mutate()} busy={consolidate.isPending}>
            Consolidate memory
          </Button>
          <Button variant="primary" onClick={() => setCreating(true)}>
            <Plus aria-hidden="true" /> New note
          </Button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0, 340px) minmax(0, 1fr)' }} data-split>
        <div className="stack" style={{ gap: 'var(--s-4)', alignContent: 'start' }}>
          <div className="field">
            <label htmlFor="vault-q" className="visually-hidden">
              Search notes
            </label>
            <div style={{ position: 'relative' }}>
              <Search aria-hidden="true" style={{ position: 'absolute', left: 12, top: 14, width: 16, height: 16, color: 'var(--muted)' }} />
              <input id="vault-q" className="input" type="search" placeholder="Search notes" value={query} onChange={(e) => setQuery(e.target.value)} style={{ paddingLeft: 36 }} />
            </div>
          </div>
          {snap.data!.tags.length ? (
            <div className="chips" aria-label="Filter by tag">
              <button type="button" className="chip" aria-pressed={!tag} onClick={() => setTag(null)} style={!tag ? { borderColor: 'var(--action)', color: 'var(--action)' } : undefined}>
                All {s.notes}
              </button>
              {snap.data!.tags.slice(0, 12).map((t) => (
                <button key={t.tag} type="button" className="chip" aria-pressed={tag === t.tag} onClick={() => setTag(tag === t.tag ? null : t.tag)} style={tag === t.tag ? { borderColor: 'var(--action)', color: 'var(--action)' } : undefined}>
                  #{t.tag} {t.count}
                </button>
              ))}
            </div>
          ) : null}
          <section className="card" aria-label="Notes">
            {q.length >= 2 && search.isLoading ? (
              <LoadingRows rows={4} />
            ) : notes.length ? (
              <ul className="list" style={{ maxHeight: 560, overflowY: 'auto' }}>
                {notes.map((n) => (
                  <li key={n.id} style={{ padding: 0 }}>
                    <button
                      type="button"
                      onClick={() => setSelected(n.id)}
                      aria-current={selected === n.id ? 'true' : undefined}
                      style={{ width: '100%', textAlign: 'left', background: selected === n.id ? 'var(--action-soft)' : 'none', border: 0, padding: 'var(--s-3) var(--s-4)', display: 'grid', gap: 2, minHeight: 44 }}
                    >
                      <span style={{ fontWeight: 500 }}>{n.title}</span>
                      <span className="small muted truncate">{'excerpt' in n && n.excerpt ? String(n.excerpt) : `${n.path} · ${n.backlinks} backlink${n.backlinks === 1 ? '' : 's'} · ${ago(n.updatedAt)}`}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty icon={Search} title={q ? 'No note matches' : 'No notes with this tag'} />
            )}
          </section>
          <p className="small muted">
            {s.notes} notes · {s.edges} links · {bytes(s.bytes)} of {bytes(s.limits.maxTotalBytes)} · memory holds {num(memory.data?.stats.episodes ?? 0)} of {num(memory.data?.stats.capacity ?? 0)} episodes
          </p>
        </div>
        <div>{selected ? <NoteView id={selected} onOpen={openByTitle} onSelect={setSelected} onDeleted={() => setSelected(null)} /> : <Card><Empty icon={BookOpen} title="Choose a note">Links in a note open the note they name. Concepts are pinned; lessons are written by the engine after each close.</Empty></Card>}</div>
      </div>
      <style>{`@media (max-width: 860px){[data-split]{grid-template-columns:minmax(0,1fr)!important}}`}</style>
      <NewNoteDialog open={creating} onClose={() => setCreating(false)} onCreated={(id) => setSelected(id)} />
    </>
  );
}

function NoteView({ id, onOpen, onSelect, onDeleted }: { id: string; onOpen: (title: string) => void; onSelect: (id: string) => void; onDeleted: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [confirm, setConfirm] = useState(false);
  const note = useQuery({ queryKey: keys.note(id), queryFn: () => api.get<{ note: VaultNote; backlinks: VaultNoteSummary[]; outgoing: VaultNoteSummary[] }>(`/api/vault/note/${encodeURIComponent(id)}`) });
  const del = useMutation({
    mutationFn: () => api.del(`/api/vault/note/${encodeURIComponent(id)}`),
    onSuccess: () => {
      toast.success('Note deleted');
      setConfirm(false);
      qc.invalidateQueries({ queryKey: keys.vault });
      onDeleted();
    },
    onError: (e) => {
      setConfirm(false);
      toast.error('The note was not deleted', errorText(e));
    },
  });
  if (note.isLoading) return <Card><LoadingRows rows={6} /></Card>;
  if (note.isError) return <Card><ErrorState error={note.error} onRetry={() => note.refetch()} /></Card>;
  const { note: n, backlinks, outgoing } = note.data!;
  return (
    <article className="card">
      <header className="card-head" style={{ alignItems: 'flex-start' }}>
        <div className="stack-sm" style={{ gap: 4 }}>
          <h2>{n.title}</h2>
          <div className="row" style={{ gap: 6 }}>
            <span className="meta">{n.path}</span>
            {n.pinned ? <Badge tone="action">Pinned</Badge> : null}
            <Badge>{n.source}</Badge>
            {n.tags.map((t) => (
              <Badge key={t}>#{t}</Badge>
            ))}
          </div>
        </div>
        {n.editable ? (
          <Button variant="danger" size="sm" onClick={() => setConfirm(true)}>
            <Trash2 aria-hidden="true" /> Delete
          </Button>
        ) : null}
      </header>
      <div className="card-body stack">
        <Markdown text={withoutTitle(n.body, n.title)} onWikilink={onOpen} />
        {backlinks.length || outgoing.length ? (
          <div className="grid grid-2" style={{ borderTop: '1px solid var(--line)', paddingTop: 'var(--s-4)' }}>
            <LinkList title="Linked from" items={backlinks} onSelect={onSelect} />
            <LinkList title="Links to" items={outgoing} onSelect={onSelect} />
          </div>
        ) : null}
        <p className="small muted">Updated {ago(n.updatedAt)} · {bytes(n.bytes)}</p>
      </div>
      <ConfirmDialog open={confirm} onClose={() => setConfirm(false)} onConfirm={() => del.mutate()} busy={del.isPending} danger title={`Delete “${n.title}”?`} confirmLabel="Delete note">
        Links to it from other notes stay, but will no longer open anything.
      </ConfirmDialog>
    </article>
  );
}

/** The card already shows the title; drop a leading "# Title" that repeats it. */
function withoutTitle(body: string, title: string): string {
  const m = body.match(/^\s*#\s+(.+?)\s*(\n|$)/);
  return m && m[1].trim().toLowerCase() === title.trim().toLowerCase() ? body.slice(m[0].length) : body;
}

function LinkList({ title, items, onSelect }: { title: string; items: VaultNoteSummary[]; onSelect: (id: string) => void }) {
  return (
    <div>
      <h3 className="label" style={{ marginBottom: 6 }}>
        {title}
      </h3>
      {items.length ? (
        <ul style={{ margin: 0, padding: 0, listStyle: 'none' }} className="stack-sm">
          {items.map((i) => (
            <li key={i.id}>
              <button type="button" className="wikilink" onClick={() => onSelect(i.id)}>
                {i.title}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">None</p>
      )}
    </div>
  );
}

function NewNoteDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [title, setTitle] = useState('');
  const [tags, setTags] = useState('');
  const [content, setContent] = useState('');
  const [errors, setErrors] = useState<{ title?: string; content?: string; form?: string }>({});
  const create = useMutation({
    mutationFn: () =>
      api.post<{ note: VaultNoteSummary }>('/api/vault/note', {
        title: title.trim(),
        path: `Notes/${title.trim().replace(/[\\/:*?"<>|]+/g, '-')}.md`,
        tags: tags.split(/[\s,]+/).map((t) => t.replace(/^#/, '')).filter(Boolean),
        content: content.trim().startsWith('#') ? content : `# ${title.trim()}\n\n${content}`,
      }),
    onSuccess: (r) => {
      toast.success('Note saved', r.note.title);
      qc.invalidateQueries({ queryKey: keys.vault });
      onCreated(r.note.id);
      setTitle('');
      setTags('');
      setContent('');
      onClose();
    },
    onError: (e) => setErrors({ form: errorText(e) }),
  });
  function submit(e: FormEvent) {
    e.preventDefault();
    const next: typeof errors = {};
    if (!title.trim()) next.title = 'Give the note a title.';
    else if (title.length > 160) next.title = 'Keep the title under 160 characters.';
    if (!content.trim()) next.content = 'Write the note before saving it.';
    setErrors(next);
    if (next.title || next.content) {
      document.getElementById(next.title ? 'note-title' : 'note-body')?.focus();
      return;
    }
    create.mutate();
  }
  return (
    <Dialog open={open} onClose={onClose} title="New note" description="Link other notes with [[Note title]]. Only you can edit or delete what you write." wide>
      <form className="form-grid" onSubmit={submit} noValidate>
        <Field label="Title" htmlFor="note-title" error={errors.title}>
          <input className="input" {...fieldProps('note-title', errors.title)} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={160} />
        </Field>
        <Field label="Tags" htmlFor="note-tags" hint="Separate with spaces or commas, for example: gold breakout">
          <input className="input" {...fieldProps('note-tags', null, true)} value={tags} onChange={(e) => setTags(e.target.value)} />
        </Field>
        <Field label="Note" htmlFor="note-body" error={errors.content} hint="Markdown: **bold**, - lists, [[links]].">
          <textarea className="textarea" rows={8} {...fieldProps('note-body', errors.content, true)} value={content} onChange={(e) => setContent(e.target.value)} />
        </Field>
        {errors.form ? <Notice kind="error">{errors.form}</Notice> : null}
        <div className="dialog-foot" style={{ padding: 0 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" busy={create.isPending}>
            Save note
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
