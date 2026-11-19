/**
 * RAM-backed Obsidian vault.
 *
 * The whole vault lives in process memory: no disk, no database rows, no
 * external service. That is deliberate — this runs on the user's own phone, and
 * the point is that the AI's growing knowledge costs nothing to host and dies
 * with the process rather than accumulating somewhere it has to be paid for.
 *
 * It is a real Obsidian-compatible model, not a note-shaped string:
 *   - notes are markdown with YAML-ish frontmatter
 *   - `[[wikilinks]]` (including `[[note|alias]]` and `[[note#heading]]`)
 *   - `#tags` parsed from both frontmatter and body
 *   - backlinks and an unlinked-mention index
 *   - a bidirectional graph for rendering
 *   - full-text search with field filters
 *
 * Everything is bounded. A phone has finite RAM, so note count, note size,
 * total bytes and graph edges all have hard caps and the oldest/least-connected
 * notes are evicted first. Growth is the feature; unbounded growth is the bug.
 */
import crypto from 'node:crypto';

const now = () => Date.now();
const uid = (p = 'note') => `${p}_${crypto.randomBytes(6).toString('hex')}`;

/** Obsidian-style wikilink, optionally aliased or heading-anchored. */
const WIKILINK_RE = /\[\[([^\]|#]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;
/** Tags: #word, not preceded by a word character (avoids URLs and colours). */
const TAG_RE = /(^|[\s(])#([A-Za-z][\w/-]{0,48})/g;

export class Vault {
  constructor({ maxNotes = 500, maxNoteBytes = 24 * 1024, maxTotalBytes = 6 * 1024 * 1024, maxEdges = 6000 } = {}) {
    this.notes = new Map(); // id -> note
    this.byTitle = new Map(); // lowercased title/alias -> id
    this.byPath = new Map(); // path -> id
    this.edges = new Map(); // "from>to" -> edge
    this.tagIndex = new Map(); // tag -> Set(noteId)
    this.stats = { writes: 0, evictions: 0, linksDropped: 0, bytes: 0 };
    this.limits = { maxNotes, maxNoteBytes, maxTotalBytes, maxEdges };
    this.touched = 0;
  }

  /* --------------------------- parsing helpers --------------------------- */

  static parseFrontmatter(raw) {
    if (!raw.startsWith('---')) return { frontmatter: {}, body: raw };
    const end = raw.indexOf('\n---', 3);
    if (end < 0) return { frontmatter: {}, body: raw };
    const block = raw.slice(3, end);
    const body = raw.slice(end + 4).replace(/^\n/, '');
    const frontmatter = {};
    for (const line of block.split('\n')) {
      const m = line.match(/^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
      if (!m) continue;
      let value = m[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value
          .slice(1, -1)
          .split(',')
          .map((s) => s.trim().replace(/^["']|["']$/g, ''))
          .filter(Boolean);
      } else {
        value = value.replace(/^["']|["']$/g, '');
      }
      frontmatter[m[1]] = value;
    }
    return { frontmatter, body };
  }

  static extractLinks(raw) {
    const out = [];
    for (const m of raw.matchAll(WIKILINK_RE)) {
      out.push({ target: m[1].trim(), heading: m[2]?.trim() ?? null, alias: m[3]?.trim() ?? null });
    }
    return out;
  }

  static extractTags(raw, frontmatter = {}) {
    const tags = new Set();
    const fmTags = frontmatter.tags ?? frontmatter.tag;
    if (Array.isArray(fmTags)) fmTags.forEach((t) => tags.add(String(t).replace(/^#/, '').toLowerCase()));
    else if (typeof fmTags === 'string' && fmTags) fmTags.split(/[,\s]+/).forEach((t) => t && tags.add(t.replace(/^#/, '').toLowerCase()));
    for (const m of raw.matchAll(TAG_RE)) tags.add(m[2].toLowerCase());
    return [...tags];
  }

  static titleOf(raw, frontmatter, fallbackPath) {
    if (frontmatter.title) return String(frontmatter.title);
    const heading = raw.match(/^#\s+(.+)$/m);
    if (heading) return heading[1].trim();
    const base = String(fallbackPath ?? '').split('/').pop()?.replace(/\.md$/, '');
    return base || 'Untitled';
  }

  /* ------------------------------- writing ------------------------------- */

  /**
   * Create or update a note. `path` is the Obsidian-style vault path, e.g.
   * `Signals/XAUUSD 2024-11-02.md`. Updating keeps the same id so backlinks and
   * graph edges survive an edit.
   */
  write({ path, content, title, tags = [], frontmatter = {}, source = 'system', owner } = {}) {
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('vault.write: content is required');
    }
    let body = content;
    let fm = { ...frontmatter };
    // If the caller supplied a full markdown document, respect its frontmatter.
    const parsed = Vault.parseFrontmatter(content);
    if (Object.keys(parsed.frontmatter).length) {
      fm = { ...parsed.frontmatter, ...frontmatter };
      body = parsed.body;
    }

    if (Buffer.byteLength(content) > this.limits.maxNoteBytes) {
      // Truncate rather than reject: a long trade log must not vanish entirely.
      const keep = Math.floor(this.limits.maxNoteBytes * 0.9);
      body = `${body.slice(0, keep)}\n\n_…truncated to fit the device memory budget._`;
    }

    const cleanPath = String(path ?? `Notes/${Vault.titleOf(body, fm, path)}.md`).replace(/^\/+/, '');
    const finalTitle = title ?? Vault.titleOf(body, fm, cleanPath);
    const allTags = [...new Set([...tags.map((t) => String(t).toLowerCase()), ...Vault.extractTags(body, fm)])];
    const links = Vault.extractLinks(body);

    const existingId = this.byPath.get(cleanPath);
    const id = existingId ?? uid();

    const note = {
      id,
      path: cleanPath,
      title: finalTitle,
      body,
      tags: allTags,
      links,
      frontmatter: { ...fm, title: finalTitle, ...(allTags.length ? { tags: allTags } : {}) },
      source,
      createdAt: existingId ? this.notes.get(existingId)?.createdAt ?? now() : now(),
      updatedAt: now(),
      bytes: Buffer.byteLength(body),
      reads: existingId ? this.notes.get(existingId)?.reads ?? 0 : 0,
      // Who may edit or delete it: a licence id, or null for system notes.
      owner: owner !== undefined ? owner : existingId ? this.notes.get(existingId)?.owner ?? null : null,
      pinned: Boolean(fm.pinned),
    };

    this.notes.set(id, note);
    this.byPath.set(cleanPath, id);
    this.byTitle.set(finalTitle.toLowerCase(), id);
    for (const alias of Array.isArray(fm.aliases) ? fm.aliases : []) this.byTitle.set(String(alias).toLowerCase(), id);

    this.stats.writes++;
    this.touched++;
    this.reindex(id);
    this.enforceLimits();
    return this.publicNote(note);
  }

  append(path, chunk, opts = {}) {
    const id = this.byPath.get(String(path ?? '').replace(/^\/+/, ''));
    if (!id) return this.write({ path, content: chunk, ...opts });
    const note = this.notes.get(id);
    return this.write({ path: note.path, content: `${note.body}\n\n${chunk}`, title: note.title, tags: note.tags, source: opts.source ?? note.source });
  }

  delete(id) {
    const note = this.notes.get(id);
    if (!note) return false;
    this.notes.delete(id);
    this.byPath.delete(note.path);
    this.byTitle.delete(note.title.toLowerCase());
    for (const [key, edge] of this.edges) {
      if (edge.from === id || edge.to === id) this.edges.delete(key);
    }
    this.reindex(id);
    this.stats.bytes = [...this.notes.values()].reduce((a, n) => a + n.bytes, 0);
    return true;
  }

  /* ------------------------------ indexing ------------------------------ */

  /** Recompute every derived structure for one note. Cheap at these sizes. */
  reindex() {
    this.tagIndex.clear();
    this.edges.clear();
    for (const [id, note] of this.notes) {
      for (const tag of note.tags) {
        if (!this.tagIndex.has(tag)) this.tagIndex.set(tag, new Set());
        this.tagIndex.get(tag).add(id);
      }
    }
    // Link resolution needs every title resolved first, so do it in a second pass.
    for (const [id, note] of this.notes) {
      for (const link of note.links) {
        const targetId = this.resolve(link.target);
        if (!targetId || targetId === id) continue;
        if (this.edges.size >= this.limits.maxEdges) {
          this.stats.linksDropped++;
          continue;
        }
        this.edges.set(`${id}>${targetId}`, { from: id, to: targetId, heading: link.heading, alias: link.alias });
      }
    }
    this.stats.bytes = [...this.notes.values()].reduce((a, n) => a + n.bytes, 0);
  }

  resolve(name) {
    if (!name) return null;
    const key = String(name).trim().toLowerCase().replace(/\.md$/, '');
    if (this.byTitle.has(key)) return this.byTitle.get(key);
    if (this.byPath.has(`${name}.md`)) return this.byPath.get(`${name}.md`);
    if (this.byPath.has(name)) return this.byPath.get(name);
    // partial path match: [[Signals/XAUUSD]] resolves a path suffix
    for (const [p, id] of this.byPath) {
      if (p.toLowerCase().endsWith(`/${key}.md`) || p.toLowerCase() === `${key}.md`) return id;
    }
    return null;
  }

  /**
   * Memory budget enforcement. Pinned notes never evict; otherwise the least
   * recently updated, least read, least connected notes go first.
   */
  enforceLimits() {
    while (this.notes.size > this.limits.maxNotes) {
      const victim = this.evictionCandidate();
      if (!victim) break;
      this.delete(victim);
      this.stats.evictions++;
    }
    let total = [...this.notes.values()].reduce((a, n) => a + n.bytes, 0);
    while (total > this.limits.maxTotalBytes && this.notes.size > 1) {
      const victim = this.evictionCandidate();
      if (!victim) break;
      const bytes = this.notes.get(victim)?.bytes ?? 0;
      this.delete(victim);
      this.stats.evictions++;
      total -= bytes;
    }
  }

  evictionCandidate() {
    const degree = new Map();
    for (const e of this.edges.values()) {
      degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
      degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    }
    let worst = null;
    let worstScore = Infinity;
    for (const [id, note] of this.notes) {
      if (note.pinned) continue;
      const score = note.updatedAt / 1e10 - (degree.get(id) ?? 0) * 2 - note.reads;
      if (score < worstScore) {
        worstScore = score;
        worst = id;
      }
    }
    return worst;
  }

  /* ------------------------------- reading ------------------------------- */

  /**
   * Serialisable shape of a note for the wire.
   *
   * Link counts are computed by direct edge scans rather than backlinks()/
   * outgoing(), which themselves map through this function — that mutual
   * recursion blew the stack, so the counts stay primitive here.
   */
  publicNote(note) {
    let inbound = 0;
    let outbound = 0;
    for (const e of this.edges.values()) {
      if (e.to === note.id) inbound++;
      if (e.from === note.id) outbound++;
    }
    return {
      id: note.id,
      path: note.path,
      title: note.title,
      tags: note.tags,
      source: note.source,
      bytes: note.bytes,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
      pinned: note.pinned,
      backlinks: inbound,
      outgoing: outbound,
    };
  }

  get(id) {
    const note = this.notes.get(id);
    if (!note) return null;
    note.reads++;
    return { ...this.publicNote(note), body: note.body, frontmatter: note.frontmatter, links: note.links, owner: note.owner ?? null };
  }

  getByTitle(title) {
    const id = this.resolve(title);
    return id ? this.get(id) : null;
  }

  list({ limit = 100, tag = null, sort = 'updated' } = {}) {
    let items = [...this.notes.values()];
    if (tag) {
      const ids = this.tagIndex.get(tag.toLowerCase());
      items = ids ? items.filter((n) => ids.has(n.id)) : [];
    }
    items.sort((a, b) => (sort === 'title' ? a.title.localeCompare(b.title) : b.updatedAt - a.updatedAt));
    return items.slice(0, limit).map((n) => this.publicNote(n));
  }

  backlinks(id) {
    const out = [];
    for (const e of this.edges.values()) {
      if (e.to === id) {
        const n = this.notes.get(e.from);
        if (n) out.push(this.publicNote(n));
      }
    }
    return out;
  }

  outgoing(id) {
    const out = [];
    for (const e of this.edges.values()) {
      if (e.from === id) {
        const n = this.notes.get(e.to);
        if (n) out.push(this.publicNote(n));
      }
    }
    return out;
  }

  /** Notes that mention a title as plain text but never linked it. */
  unlinkedMentions(id) {
    const note = this.notes.get(id);
    if (!note) return [];
    const needle = note.title.toLowerCase();
    const out = [];
    for (const other of this.notes.values()) {
      if (other.id === id) continue;
      if (other.body.toLowerCase().includes(needle) && !other.links.some((l) => this.resolve(l.target) === id)) {
        out.push(this.publicNote(other));
      }
    }
    return out;
  }

  /* -------------------------------- search ------------------------------ */

  /** Field-filtered search: `tag:signals xauusd`, `title:risk`, `source:ai`. */
  search(query, { limit = 20 } = {}) {
    const q = String(query ?? '').trim();
    if (!q) return [];
    const terms = [];
    const filters = { tag: [], source: null, title: null, path: null };
    for (const raw of q.split(/\s+/)) {
      const m = raw.match(/^(tag|source|title|path):(.+)$/i);
      if (m) {
        const key = m[1].toLowerCase();
        if (key === 'tag') filters.tag.push(m[2].toLowerCase());
        else filters[key] = m[2].toLowerCase();
      } else terms.push(raw.toLowerCase());
    }

    const scored = [];
    for (const note of this.notes.values()) {
      if (filters.source && note.source !== filters.source) continue;
      if (filters.title && !note.title.toLowerCase().includes(filters.title)) continue;
      if (filters.path && !note.path.toLowerCase().includes(filters.path)) continue;
      if (filters.tag.length && !filters.tag.every((t) => note.tags.includes(t))) continue;

      let score = 0;
      const hay = `${note.title}\n${note.body}`.toLowerCase();
      const titleLower = note.title.toLowerCase();
      let allTermsPresent = true;
      for (const term of terms) {
        if (titleLower.includes(term)) score += 20;
        const occurrences = hay.split(term).length - 1;
        if (occurrences === 0) allTermsPresent = false;
        score += Math.min(occurrences, 8) * 2;
      }
      if (!allTermsPresent) continue;
      if (terms.length === 0) score += 1;
      if (note.pinned) score += 3;
      score += (note.reads ?? 0) * 0.1;
      if (score <= 0) continue;
      scored.push({ note, score });
    }
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, limit).map(({ note, score }) => ({ ...this.publicNote(note), score: Math.round(score * 10) / 10, excerpt: excerpt(note.body, terms) }));
  }

  /* --------------------------------- graph ------------------------------ */

  /**
   * Graph payload for the animated renderer. Nodes carry a degree so the client
   * can size them, and a group so it can colour them without extra lookups.
   */
  graph({ limit = 300 } = {}) {
    const nodes = [...this.notes.values()]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, limit);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = [...this.edges.values()]
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e, i) => ({ id: `e${i}`, source: e.from, target: e.to }));

    const degree = new Map();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }

    return {
      nodes: nodes.map((n) => ({
        id: n.id,
        title: n.title,
        path: n.path,
        tags: n.tags,
        source: n.source,
        group: n.source === 'ai' ? 'ai' : n.source === 'signal' ? 'signal' : n.source === 'trade' ? 'trade' : 'note',
        degree: degree.get(n.id) ?? 0,
        bytes: n.bytes,
        updatedAt: n.updatedAt,
      })),
      edges,
      meta: {
        notes: this.notes.size,
        edges: this.edges.size,
        tags: this.tagIndex.size,
        bytes: this.stats.bytes,
        evictions: this.stats.evictions,
        limits: this.limits,
      },
    };
  }

  tags() {
    return [...this.tagIndex.entries()]
      .map(([tag, ids]) => ({ tag, count: ids.size }))
      .sort((a, b) => b.count - a.count);
  }

  /** Everything in one payload: used by the vault screen on first paint. */
  snapshot({ limit = 120 } = {}) {
    return {
      graph: this.graph(),
      notes: this.list({ limit }),
      tags: this.tags(),
      stats: {
        notes: this.notes.size,
        edges: this.edges.size,
        tags: this.tagIndex.size,
        bytes: this.stats.bytes,
        writes: this.stats.writes,
        evictions: this.stats.evictions,
        limits: this.limits,
      },
    };
  }

  clear() {
    this.notes.clear();
    this.byTitle.clear();
    this.byPath.clear();
    this.edges.clear();
    this.tagIndex.clear();
    this.stats = { writes: 0, evictions: 0, linksDropped: 0, bytes: 0 };
  }
}

function excerpt(body, terms) {
  const flat = body.replace(/[#*`>]/g, '').replace(/\s+/g, ' ').trim();
  if (!terms.length) return flat.slice(0, 160);
  for (const t of terms) {
    const i = flat.toLowerCase().indexOf(t);
    if (i >= 0) return `${i > 40 ? '…' : ''}${flat.slice(Math.max(0, i - 40), i + 130).trim()}…`;
  }
  return flat.slice(0, 160);
}
