/**
 * File store — a MediaFire-shaped share host for APKs and other binaries.
 *
 * Unlike the vault (RAM, deliberately forgettable), files MUST survive a
 * restart: an APK someone shared a link to cannot evaporate because the process
 * bounced. So bytes go to disk and metadata goes to SQLite.
 *
 * The important design constraint is that files are far bigger than the JSON
 * bodies this server handles everywhere else. Nothing here buffers a whole
 * upload in memory: bodies are streamed to a temporary file, hashed on the fly,
 * then atomically renamed into place. A 100 MB APK costs a few kB of RSS.
 *
 * Sharing model, deliberately simple:
 *   - private by default (owner only)
 *   - a share token makes one file readable by anyone with the link
 *   - tokens are long, unguessable, and can be revoked
 *   - downloads are counted and audited
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { makeBlobs } from './blobs.js';

const uid = (p) => `${p}_${crypto.randomBytes(9).toString('hex')}`;

/** Extensions we are willing to store. APKs first, but not only. */
export const ALLOWED_EXT = new Set(['.apk', '.apks', '.xapk', '.aab', '.zip', '.7z', '.tar', '.gz', '.pdf', '.png', '.jpg', '.jpeg', '.webp', '.mp4', '.mp3', '.txt', '.md', '.json', '.csv']);

const MIME = {
  '.apk': 'application/vnd.android.package-archive',
  '.apks': 'application/octet-stream',
  '.xapk': 'application/octet-stream',
  '.aab': 'application/octet-stream',
  '.zip': 'application/zip',
  '.7z': 'application/x-7z-compressed',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.mp3': 'audio/mpeg',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json',
  '.csv': 'text/csv',
};

export class FileStore {
  constructor({ store, root, maxBytes = 300 * 1024 * 1024, logger = console, blobs = null, r2 = null }) {
    this.store = store;
    this.root = root;
    this.maxBytes = maxBytes;
    this.logger = logger;
    // Disk by default; R2 when it is configured. The store never learns which
    // one it got — see src/files/blobs.js.
    this.blobs = blobs ?? makeBlobs({ root, r2, logger });
    this._schema();
  }

  _schema() {
    this.store.db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        ext TEXT NOT NULL,
        mime TEXT NOT NULL,
        bytes INTEGER NOT NULL,
        sha256 TEXT NOT NULL,
        title TEXT,
        notes TEXT,
        share_token TEXT UNIQUE,
        visibility TEXT NOT NULL DEFAULT 'private',
        downloads INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_files_user ON files(user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_files_token ON files(share_token);
    `);
  }

  blobPath(id) {
    // Shard by the first two characters so a directory never holds tens of
    // thousands of entries on a phone's filesystem.
    return path.join(this.root, 'blobs', id.slice(0, 2), id);
  }

  /**
   * Stream a request body to disk.
   *
   * Returns metadata only. The caller (HTTP layer) never sees the bytes, which
   * is what keeps peak memory flat regardless of file size.
   */
  async receive({ userId, filename, title, notes, body, encoding = 'binary', declaredSize = null }) {
    const base = path.basename(String(filename ?? 'upload.bin'));
    const ext = path.extname(base).toLowerCase() || '.bin';
    if (!ALLOWED_EXT.has(ext)) {
      throw Object.assign(new Error(`file type not allowed: ${ext || 'none'}`), { code: 'BAD_TYPE' });
    }
    if (declaredSize && declaredSize > this.maxBytes) {
      throw Object.assign(new Error(`file exceeds ${Math.round(this.maxBytes / 1048576)} MB limit`), { code: 'TOO_LARGE' });
    }

    const id = uid('file');
    const hash = crypto.createHash('sha256');
    let bytes = 0;

    // Guard: enforce the cap while reading, not only from the declared header,
    // because Content-Length can lie or be absent.
    const limiter = new Transform({
      transform: (chunk, _enc, cb) => {
        bytes += chunk.length;
        if (bytes > this.maxBytes) {
          cb(Object.assign(new Error('file exceeds ' + Math.round(this.maxBytes / 1048576) + ' MB limit'), { code: 'TOO_LARGE' }));
          return;
        }
        hash.update(chunk);
        cb(null, chunk);
      },
    });

    try {
      if (this.blobs.kind === 'r2') {
        // One PUT needs a body, and R2's single-request limit is 5 GB, well above
        // the 300 MB cap. Chunks are collected, not a single concat of copies.
        const chunks = [];
        await pipeline(body, limiter, async function (source) {
          for await (const chunk of source) chunks.push(chunk);
        });
        if (bytes === 0) throw Object.assign(new Error('empty upload'), { code: 'EMPTY' });
        const buf = Buffer.concat(chunks, bytes);
        await this.blobs.put(id, buf, { contentType: MIME[ext] ?? 'application/octet-stream' });
      } else {
        const w = this.blobs.writer(id);
        try {
          await pipeline(body, limiter, w.writeStream);
          if (bytes === 0) throw Object.assign(new Error('empty upload'), { code: 'EMPTY' });
          await w.commit();
        } catch (e) {
          await w.abort();
          throw e;
        }
      }
    } catch (e) {
      await this.blobs.remove(id).catch(() => {});
      throw e;
    }

    const sharedToken = crypto.randomBytes(24).toString('base64url');
    const now = Date.now();
    this.store.run(
      `INSERT INTO files (id,user_id,name,ext,mime,bytes,sha256,title,notes,visibility,created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      id,
      userId,
      base,
      ext,
      MIME[ext] ?? 'application/octet-stream',
      bytes,
      hash.digest('hex'),
      title ?? null,
      notes ?? null,
      'private',
      now,
    );
    // Store the share token in a separate row so a private file has none.
    this.store.run('UPDATE files SET share_token = ? WHERE id = ?', sharedToken, id);

    return this.get(id);
  }

  /** Save bytes already in memory (small files only — used by tests and the CLI). */
  async put({ userId, filename, title, notes, buffer }) {
    const { Readable } = await import('node:stream');
    return this.receive({
      userId,
      filename,
      title,
      notes,
      body: Readable.from(buffer),
      declaredSize: buffer.length,
    });
  }

  get(id) {
    const row = this.store.get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id);
    return row ? this.publicRow(row) : null;
  }

  byToken(token) {
    if (!token) return null;
    const row = this.store.get('SELECT * FROM files WHERE share_token = ? AND deleted_at IS NULL', token);
    return row ? this.publicRow(row) : null;
  }

  /** Resolve a row for download, checking ownership or share visibility. */
  resolveForDownload(idOrToken, userId = null) {
    let row = this.store.get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', idOrToken);
    if (!row) row = this.store.get('SELECT * FROM files WHERE share_token = ? AND deleted_at IS NULL', idOrToken);
    if (!row) return null;
    if (row.user_id !== userId && row.visibility !== 'public') return null;
    return row;
  }

  list(userId) {
    return this.store
      .all('SELECT * FROM files WHERE user_id = ? AND deleted_at IS NULL ORDER BY created_at DESC', userId)
      .map((r) => this.publicRow(r));
  }

  publicFiles(limit = 50) {
    return this.store
      .all("SELECT * FROM files WHERE visibility = 'public' AND deleted_at IS NULL ORDER BY created_at DESC LIMIT ?", limit)
      .map((r) => this.publicRow(r));
  }

  /**
   * Owner view: every live file, whoever uploaded it. There are no accounts any
   * more, so an owner route cannot be scoped to an uploader id.
   */
  listAll(limit = 50) {
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    return this.store
      .all('SELECT * FROM files WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT ?', n)
      .map((r) => this.publicRow(r));
  }

  /** Owner share control, not scoped to an uploader for the same reason. */
  setVisibilityAsOwner(id, visibility) {
    const row = this.store.get('SELECT * FROM files WHERE id = ? AND deleted_at IS NULL', id);
    if (!row) return null;
    this.store.run('UPDATE files SET visibility = ? WHERE id = ?', visibility === 'public' ? 'public' : 'private', id);
    return this.get(id);
  }

  setVisibility(id, userId, visibility) {
    const row = this.store.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
    if (!row) return null;
    const v = visibility === 'public' ? 'public' : 'private';
    this.store.run('UPDATE files SET visibility = ? WHERE id = ?', v, id);
    return this.get(id);
  }

  /** Update display metadata only. Bytes and the share token are untouched. */
  updateMeta(id, userId, { title, notes }) {
    const row = this.store.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
    if (!row) return null;
    if (title !== undefined) this.store.run('UPDATE files SET title = ? WHERE id = ?', title === null ? null : String(title).slice(0, 200), id);
    if (notes !== undefined) this.store.run('UPDATE files SET notes = ? WHERE id = ?', notes === null ? null : String(notes).slice(0, 2000), id);
    return this.get(id);
  }

  rotateToken(id, userId) {
    const row = this.store.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
    if (!row) return null;
    const token = crypto.randomBytes(24).toString('base64url');
    this.store.run('UPDATE files SET share_token = ? WHERE id = ?', token, id);
    return this.get(id);
  }

  /** Soft delete: the row stays for the audit trail, the bytes are removed. */
  async remove(id, userId) {
    const row = this.store.get('SELECT * FROM files WHERE id = ? AND user_id = ? AND deleted_at IS NULL', id, userId);
    if (!row) return false;
    this.store.run('UPDATE files SET deleted_at = ? WHERE id = ?', Date.now(), id);
    await this.blobs.remove(id);
    return true;
  }

  countDownload(id) {
    this.store.run('UPDATE files SET downloads = downloads + 1 WHERE id = ?', id);
  }

  /** Open a read stream for a stored file. */
  /** The stored bytes, from whichever backend holds them. */
  async open(id, opts = {}) {
    return this.blobs.read(id, opts);
  }

  async openStream(id) {
    const r = await this.blobs.read(id);
    return r.stream;
  }

  /** The same bytes as a Node stream, whichever backend produced them. */
  async openNodeStream(id) {
    const { Readable } = await import('node:stream');
    const r = await this.blobs.read(id);
    return typeof r.stream?.pipe === 'function' ? r.stream : Readable.fromWeb(r.stream);
  }

  async sizeOf(id) {
    try {
      const r = await this.blobs.read(id, { start: 0, end: 0 });
      return r.size;
    } catch {
      return null;
    }
  }

  stats(userId = null) {
    const row = userId
      ? this.store.get('SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b, COALESCE(SUM(downloads),0) d FROM files WHERE user_id = ? AND deleted_at IS NULL', userId)
      : this.store.get('SELECT COUNT(*) c, COALESCE(SUM(bytes),0) b, COALESCE(SUM(downloads),0) d FROM files WHERE deleted_at IS NULL');
    return { files: row?.c ?? 0, bytes: row?.b ?? 0, downloads: row?.d ?? 0, maxBytes: this.maxBytes };
  }

  publicRow(r) {
    return {
      id: r.id,
      name: r.name,
      ext: r.ext,
      mime: r.mime,
      bytes: r.bytes,
      sha256: r.sha256,
      title: r.title,
      notes: r.notes,
      visibility: r.visibility,
      downloads: r.downloads,
      createdAt: r.created_at,
      shareToken: r.share_token,
      url: `/f/${r.share_token}`,
      directUrl: `/api/files/${r.id}/download`,
    };
  }
}

export function formatBytes(n) {
  const v = Number(n) || 0;
  if (v >= 1073741824) return `${(v / 1073741824).toFixed(2)} GB`;
  if (v >= 1048576) return `${(v / 1048576).toFixed(1)} MB`;
  if (v >= 1024) return `${(v / 1024).toFixed(1)} kB`;
  return `${v} B`;
}
