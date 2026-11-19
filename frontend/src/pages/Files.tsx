import { useRef, useState, type DragEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Download, FileStack, Globe, Lock, RefreshCw, Trash2, Upload } from 'lucide-react';
import { api, API_BASE, errorText, upload } from '../lib/api';
import { keys } from '../lib/queries';
import { ago, bytes } from '../lib/format';
import type { FileRow } from '../lib/types';
import { Badge, Button, Card, ConfirmDialog, Empty, ErrorState, LoadingRows, Notice } from '../components/ui';
import { useToast } from '../components/Toast';

const ALLOWED = ['.apk', '.apks', '.xapk', '.aab', '.zip', '.7z', '.tar', '.gz', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mp3', '.txt', '.md', '.json', '.csv'];

function absolute(path: string) {
  return new URL(`${API_BASE}${path}`, window.location.origin).toString();
}

export function Files() {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [progress, setProgress] = useState<{ name: string; fraction: number } | null>(null);
  const [drag, setDrag] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = useQuery({ queryKey: keys.files, queryFn: () => api.get<{ files: FileRow[]; publicFiles: FileRow[]; stats: { files: number; bytes: number; downloads: number; maxBytes: number } | null }>('/api/files') });
  const max = files.data?.stats?.maxBytes ?? 0;

  async function send(file: File) {
    setError(null);
    const ext = `.${file.name.split('.').pop()?.toLowerCase() ?? ''}`;
    if (!ALLOWED.includes(ext)) {
      setError(`${file.name} cannot be uploaded: ${ext} files are not accepted. Allowed: ${ALLOWED.join(' ')}`);
      return;
    }
    if (max && file.size > max) {
      setError(`${file.name} is ${bytes(file.size)}; the limit is ${bytes(max)}.`);
      return;
    }
    setProgress({ name: file.name, fraction: 0 });
    try {
      await upload('/api/files', file, { name: file.name, title: file.name.replace(/\.[^.]+$/, '') }, (f) => setProgress({ name: file.name, fraction: f }));
      toast.success('Uploaded', `${file.name} is private until you publish it.`);
      qc.invalidateQueries({ queryKey: keys.files });
    } catch (e) {
      setError(errorText(e));
    } finally {
      setProgress(null);
      if (input.current) input.current.value = '';
    }
  }

  function onDrop(e: DragEvent) {
    e.preventDefault();
    setDrag(false);
    const f = e.dataTransfer.files?.[0];
    if (f) send(f);
  }

  if (files.isError) return <ErrorState error={files.error} onRetry={() => files.refetch()} />;
  if (files.data && !files.data.stats) {
    return (
      <Card>
        <Empty icon={FileStack} title="File sharing is off on this server">The owner can enable it with LUMINA_FILES=1.</Empty>
      </Card>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h2>Files</h2>
          <p>Upload installers, reports or exports and share them by link. Files stay private until you publish them; a published link works without signing in.</p>
        </div>
        <a className="btn btn--ghost" href={`${API_BASE}/dl`} target="_blank" rel="noopener noreferrer">
          <Globe aria-hidden="true" /> Public file list
        </a>
      </div>

      <section
        className="card"
        aria-label="Upload"
        onDragOver={(e) => {
          e.preventDefault();
          setDrag(true);
        }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        style={{ borderStyle: 'dashed', borderColor: drag ? 'var(--action)' : 'var(--line-strong)', background: drag ? 'var(--action-soft)' : undefined }}
      >
        <div className="card-body row-between" style={{ flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 'var(--s-3)' }}>
            <Upload aria-hidden="true" style={{ width: 22, height: 22, color: 'var(--action)' }} />
            <div>
              <strong style={{ fontWeight: 500 }}>Drop a file here, or choose one</strong>
              <div className="small muted">Up to {bytes(max)} · APK, ZIP, PDF, images, audio, video, text and CSV</div>
            </div>
          </div>
          <div>
            <input ref={input} id="file-input" type="file" className="visually-hidden" accept={ALLOWED.join(',')} onChange={(e) => e.target.files?.[0] && send(e.target.files[0])} />
            <Button variant="primary" onClick={() => input.current?.click()} busy={Boolean(progress)}>
              Choose a file
            </Button>
          </div>
        </div>
        {progress ? (
          <div style={{ padding: '0 var(--s-5) var(--s-5)' }}>
            <div className="row-between small" style={{ marginBottom: 6 }}>
              <span className="truncate">{progress.name}</span>
              <span className="num">{Math.round(progress.fraction * 100)}%</span>
            </div>
            <div className="meter" role="progressbar" aria-label={`Uploading ${progress.name}`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress.fraction * 100)}>
              <span style={{ width: `${progress.fraction * 100}%` }} />
            </div>
          </div>
        ) : null}
      </section>
      {error ? <Notice kind="error" title="Upload refused">{error}</Notice> : null}

      <Card title="Your files" meta={files.data?.stats ? `${files.data.stats.files} file${files.data.stats.files === 1 ? '' : 's'} · ${bytes(files.data.stats.bytes)} · ${files.data.stats.downloads} downloads` : undefined} bodyClass="flush">
        {files.isLoading ? (
          <LoadingRows rows={3} />
        ) : files.data!.files.length ? (
          <ul className="list">
            {files.data!.files.map((f) => (
              <FileItem key={f.id} file={f} />
            ))}
          </ul>
        ) : (
          <Empty icon={FileStack} title="No files yet">Uploaded files appear here with their share controls.</Empty>
        )}
      </Card>
    </>
  );
}

function FileItem({ file }: { file: FileRow }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [copied, setCopied] = useState(false);
  const [confirm, setConfirm] = useState<'delete' | 'rotate' | null>(null);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.files });
  const visibility = useMutation({
    mutationFn: (publish: boolean) => api.post(`/api/files/${file.id}/${publish ? 'publish' : 'unpublish'}`),
    onSuccess: (_r, publish) => {
      toast.success(publish ? 'Published' : 'Made private', publish ? 'Anyone with the link can download it.' : 'The share link no longer works.');
      refresh();
    },
    onError: (e) => toast.error('Visibility was not changed', errorText(e)),
  });
  const rotate = useMutation({
    mutationFn: () => api.post(`/api/files/${file.id}/rotate`),
    onSuccess: () => {
      toast.success('New link created', 'The old link stopped working.');
      setConfirm(null);
      refresh();
    },
    onError: (e) => toast.error('The link was not replaced', errorText(e)),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/api/files/${file.id}`),
    onSuccess: () => {
      toast.success('File deleted', file.name);
      setConfirm(null);
      refresh();
    },
    onError: (e) => toast.error('The file was not deleted', errorText(e)),
  });
  const share = absolute(file.url);
  const isPublic = file.visibility === 'public';

  return (
    <li className="row-between" style={{ flexWrap: 'wrap', gap: 'var(--s-3)' }}>
      <div className="row" style={{ gap: 'var(--s-3)', minWidth: 0, flex: '1 1 260px' }}>
        <span className="badge" style={{ height: 36, width: 44, justifyContent: 'center', fontFamily: 'var(--font-mono)' }}>
          {file.ext.replace('.', '').toUpperCase()}
        </span>
        <div style={{ minWidth: 0 }}>
          <div className="truncate" style={{ fontWeight: 500 }}>
            {file.title || file.name}
          </div>
          <div className="small muted">
            {file.name} · {bytes(file.bytes)} · {file.downloads} download{file.downloads === 1 ? '' : 's'} · {ago(file.createdAt)}
          </div>
        </div>
      </div>
      <div className="row" style={{ gap: 4 }}>
        <Badge tone={isPublic ? 'up' : ''}>
          {isPublic ? <Globe aria-hidden="true" style={{ width: 12, height: 12 }} /> : <Lock aria-hidden="true" style={{ width: 12, height: 12 }} />}
          {isPublic ? 'Public' : 'Private'}
        </Badge>
        {isPublic ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(share);
                setCopied(true);
                window.setTimeout(() => setCopied(false), 1800);
              } catch {
                toast.info('Copy the link', share);
              }
            }}
          >
            {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
            {copied ? 'Copied' : 'Copy link'}
          </Button>
        ) : null}
        <a className="btn btn--ghost btn--sm" href={`${API_BASE}${file.directUrl}`} download>
          <Download aria-hidden="true" /> Download
        </a>
        <Button size="sm" onClick={() => visibility.mutate(!isPublic)} busy={visibility.isPending}>
          {isPublic ? 'Make private' : 'Publish'}
        </Button>
        {isPublic ? (
          <Button size="sm" variant="ghost" icon onClick={() => setConfirm('rotate')} aria-label={`Replace the share link of ${file.name}`}>
            <RefreshCw />
          </Button>
        ) : null}
        <Button size="sm" variant="ghost" icon onClick={() => setConfirm('delete')} aria-label={`Delete ${file.name}`}>
          <Trash2 />
        </Button>
      </div>
      <ConfirmDialog open={confirm === 'delete'} onClose={() => setConfirm(null)} onConfirm={() => remove.mutate()} busy={remove.isPending} danger title={`Delete ${file.name}?`} confirmLabel="Delete file">
        The bytes are removed and every link to it stops working.
      </ConfirmDialog>
      <ConfirmDialog open={confirm === 'rotate'} onClose={() => setConfirm(null)} onConfirm={() => rotate.mutate()} busy={rotate.isPending} title="Replace the share link?" confirmLabel="Create new link">
        Anyone holding the current link loses access. Use this if a link was shared too widely.
      </ConfirmDialog>
    </li>
  );
}
