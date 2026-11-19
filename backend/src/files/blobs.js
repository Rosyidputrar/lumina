/**
 * Where the bytes live.
 *
 * The file store used to write straight to disk. That works, but a VPS has a
 * small disk and every download is bandwidth it pays for. Cloudflare R2 has no
 * egress fee and 10 GB free, so it is the better home for shared APKs.
 *
 * Two implementations behind one interface, chosen by configuration:
 *
 *   disk  — local filesystem, the default, works with no account at all
 *   r2    — any S3-compatible bucket, signed here (no SDK, no dependency)
 *
 * The store does not care which one it got. Everything it needs is expressed as
 * four methods, so a third backend (S3, B2, GCS) would be a new class and no
 * changes elsewhere.
 *
 * Node builtins only. Signature v4 is implemented here because adding the AWS
 * SDK for one call would double the dependency count of a project that has none.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/* ───────────────────────────────── disk ─────────────────────────────────── */

export class DiskBlobs {
  constructor({ root }) {
    this.root = root;
    this.kind = 'disk';
    fs.mkdirSync(path.join(root, 'blobs'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tmp'), { recursive: true });
  }

  /** Shard by the leading two characters so one directory never holds millions. */
  blobPath(id) {
    return path.join(this.root, 'blobs', id.slice(0, 2), `${id}.bin`);
  }

  tmpPath(id) {
    return path.join(this.root, 'tmp', `${id}.part`);
  }

  /** Where a stream should be written. Disk has a temp file then an atomic move. */
  writer(id) {
    const finalPath = this.blobPath(id);
    const tmpPath = this.tmpPath(id);
    fs.mkdirSync(path.dirname(finalPath), { recursive: true });
    return {
      writeStream: fs.createWriteStream(tmpPath),
      commit: async () => {
        await fs.promises.rename(tmpPath, finalPath);
      },
      abort: async () => {
        await fs.promises.rm(tmpPath, { force: true }).catch(() => {});
        await fs.promises.rm(finalPath, { force: true }).catch(() => {});
      },
    };
  }

  /**
   * Stream a stored file. `onBytes(n)` lets the store honour range requests
   * without loading the file to measure it.
   */
  async read(id, { start = 0, end = null } = {}) {
    const p = this.blobPath(id);
    const stat = await fs.promises.stat(p).catch(() => null);
    if (!stat) throw Object.assign(new Error('blob missing'), { code: 'NO_BLOB' });
    const last = end === null || end === undefined ? stat.size - 1 : Math.min(end, stat.size - 1);
    return {
      stream: fs.createReadStream(p, { start, end: last }),
      size: stat.size,
      range: { start, end: last },
    };
  }

  async remove(id) {
    await fs.promises.rm(this.blobPath(id), { force: true }).catch(() => {});
  }

  async exists(id) {
    return fs.promises.stat(this.blobPath(id)).then(() => true).catch(() => false);
  }
}

/* ────────────────────────────────── R2 ──────────────────────────────────── */

const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
const sha256hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Minimal S3 client: signed PUT, GET and DELETE against one bucket.
 *
 * Path-style addressing is used (`endpoint/bucket/key`) because it works with
 * R2, MinIO, Backblaze B2 and most compatible services without per-provider
 * hostname rules.
 */
export class R2Blobs {
  constructor({ endpoint, bucket, accessKeyId, secretAccessKey, region = 'auto', prefix = '', logger = console }) {
    if (!endpoint || !bucket || !accessKeyId || !secretAccessKey) {
      throw new Error('R2 needs endpoint, bucket, accessKeyId and secretAccessKey');
    }
    this.base = endpoint.replace(/\/+$/, '');
    this.bucket = bucket;
    this.accessKeyId = accessKeyId;
    this.secretAccessKey = secretAccessKey;
    this.region = region;
    this.prefix = prefix.replace(/^\/+|\/+$/g, '');
    this.kind = 'r2';
    this.logger = logger;
  }

  keyOf(id) {
    return this.prefix ? `${this.prefix}/${id}.bin` : `${id}.bin`;
  }

  objectUrl(id) {
    return `${this.base}/${this.bucket}/${this.keyOf(id)}`;
  }

  /**
   * Signature v4 for a single request.
   *
   * Only the headers actually used are signed. Signing a header the caller then
   * omits is the most common cause of a 403 from S3-compatible services.
   */
  sign(method, url, { payloadHash = 'UNSIGNED-PAYLOAD', extraHeaders = {} } = {}) {
    const u = new URL(url);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);

    const headers = {
      host: u.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...extraHeaders,
    };

    const sortedKeys = Object.keys(headers).map((k) => k.toLowerCase()).sort();
    const lower = {};
    for (const k of Object.keys(headers)) lower[k.toLowerCase()] = String(headers[k]);
    const canonicalHeaders = sortedKeys.map((k) => `${k}:${lower[k].trim()}\n`).join('');
    const signedHeaders = sortedKeys.join(';');

    // Query parameters must be sorted and encoded the same way S3 does.
    const params = [...u.searchParams.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const canonicalQuery = params.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&');

    const canonicalRequest = [
      method,
      u.pathname.split('/').map(enc).join('/').replace(/%2F/g, '/'),
      canonicalQuery,
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.region}/s3/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');

    let key = hmac(`AWS4${this.secretAccessKey}`, dateStamp);
    key = hmac(key, this.region);
    key = hmac(key, 's3');
    key = hmac(key, 'aws4_request');
    const signature = crypto.createHmac('sha256', key).update(stringToSign).digest('hex');

    return {
      ...headers,
      authorization: `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    };
  }

  async put(id, body, { contentType } = {}) {
    const url = this.objectUrl(id);
    // A single PUT needs the payload hash; multipart was not worth the code for
    // 300 MB files, so the body is buffered by the caller's writer instead.
    const headers = this.sign('PUT', url, {
      payloadHash: 'UNSIGNED-PAYLOAD',
      extraHeaders: contentType ? { 'content-type': contentType } : {},
    });
    const res = await fetch(url, { method: 'PUT', headers, body });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`R2 PUT failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    return { size: body?.length ?? null };
  }

  async read(id, { start = 0, end = null } = {}) {
    const url = this.objectUrl(id);
    const ranges = {};
    if (start || end !== null) {
      ranges.range = `bytes=${start}-${end === null || end === undefined ? '' : end}`;
    }
    const headers = this.sign('GET', url, { extraHeaders: ranges });
    const res = await fetch(url, { method: 'GET', headers });
    if (!res.ok) {
      if (res.status === 404) throw Object.assign(new Error('blob missing'), { code: 'NO_BLOB' });
      throw new Error(`R2 GET failed: HTTP ${res.status}`);
    }
    const total = Number(res.headers.get('content-length') || 0);
    const contentRange = res.headers.get('content-range');
    let size = total;
    let range = { start, end: total - 1 };
    if (contentRange) {
      const m = contentRange.match(/bytes (\d+)-(\d+)\/(\d+)/);
      if (m) {
        range = { start: Number(m[1]), end: Number(m[2]) };
        size = Number(m[3]);
      }
    }
    return { stream: res.body, size, range };
  }

  async remove(id) {
    const url = this.objectUrl(id);
    const headers = this.sign('DELETE', url);
    const res = await fetch(url, { method: 'DELETE', headers });
    // 404 means it was already gone, which is the desired end state.
    if (!res.ok && res.status !== 404) throw new Error(`R2 DELETE failed: HTTP ${res.status}`);
  }

  async exists(id) {
    const url = this.objectUrl(id);
    const headers = this.sign('HEAD', url);
    const res = await fetch(url, { method: 'HEAD', headers });
    return res.ok;
  }
}

/* ─────────────────────────────── selection ──────────────────────────────── */

/**
 * Pick a backend from configuration. Falls back to disk with a clear log line
 * rather than throwing: a server with a working disk should still start if the
 * bucket credentials are missing.
 */
export function makeBlobs({ root, r2 = null, logger = console }) {
  if (r2 && r2.endpoint && r2.bucket && r2.accessKeyId && r2.secretAccessKey) {
    logger.info?.(`[files] R2 bucket "${r2.bucket}" at ${r2.endpoint}`);
    return new R2Blobs({ ...r2, logger });
  }
  if (r2 && (r2.endpoint || r2.bucket)) {
    logger.warn?.('[files] R2 is partially configured; falling back to disk');
  }
  logger.info?.(`[files] local disk at ${root}`);
  return new DiskBlobs({ root });
}
