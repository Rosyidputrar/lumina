/**
 * The AI's memory.
 *
 * This is what makes the assistant grow instead of resetting every request.
 * It has two tiers, both in RAM:
 *
 *   episodic  — a bounded ring buffer of raw observations (what the engine saw,
 *               what it decided, what the user asked). Cheap, high volume,
 *               deliberately forgettable.
 *   semantic  — durable knowledge written into the Obsidian vault as linked
 *               notes. Low volume, curated, survives as long as the process.
 *
 * A consolidation pass turns episodes into semantic notes: repeated patterns
 * become concepts, decisions become dated records, and outcomes attach to the
 * setup that produced them. That is the difference between logging and learning.
 */
import crypto from 'node:crypto';

const now = () => Date.now();
const uid = (p) => `${p}_${crypto.randomBytes(6).toString('hex')}`;
const dayKey = (ts = now()) => new Date(ts).toISOString().slice(0, 10);

export class Memory {
  constructor({ vault, maxEpisodes = 4000, maxRecall = 12 } = {}) {
    if (!vault) throw new Error('Memory requires a vault');
    this.vault = vault;
    this.episodes = [];
    this.maxEpisodes = maxEpisodes;
    this.maxRecall = maxRecall;
    this.conversations = new Map(); // userId -> [{role, content, ts}]
    this.counters = { recorded: 0, consolidated: 0, dropped: 0 };
    this.lastConsolidation = 0;
    this.profiles = new Map(); // userId -> learned preferences/facts
  }

  /* ------------------------------- episodes ------------------------------ */

  /**
   * Record one observation. `kind` is the axis we consolidate on:
   *   signal | trade | question | insight | regime | risk
   */
  record({ kind, userId = null, symbol = null, summary, detail = {}, tags = [], importance = 0.5 }) {
    if (!summary) return null;
    const episode = {
      id: uid('ep'),
      kind,
      userId,
      symbol,
      summary: String(summary).slice(0, 800),
      detail,
      tags,
      importance: clamp(importance, 0, 1),
      ts: now(),
    };
    this.episodes.push(episode);
    this.counters.recorded++;
    if (this.episodes.length > this.maxEpisodes) {
      // drop the least important of the oldest third, not simply the oldest:
      // a boring episode from an hour ago is less worth keeping than a big one
      const window = this.episodes.slice(0, Math.floor(this.maxEpisodes / 3));
      window.sort((a, b) => a.importance - b.importance);
      const remove = new Set(window.slice(0, Math.ceil(window.length / 3)).map((e) => e.id));
      this.episodes = this.episodes.filter((e) => !remove.has(e.id));
      this.counters.dropped += remove.size;
    }
    return episode;
  }

  /** Recent episodes, newest first, optionally filtered. */
  recent({ kind = null, symbol = null, userId = null, limit = 40 } = {}) {
    const out = [];
    for (let i = this.episodes.length - 1; i >= 0 && out.length < limit; i--) {
      const e = this.episodes[i];
      if (kind && e.kind !== kind) continue;
      if (symbol && e.symbol !== symbol) continue;
      if (userId && e.userId !== userId) continue;
      out.push(e);
    }
    return out;
  }

  /* -------------------------------- recall ------------------------------- */

  /**
   * Retrieve what the AI should remember right now, given a question or a
   * symbol. This is the retrieval half of RAG, over both tiers: vault notes by
   * full-text relevance, plus the most relevant recent episodes.
   */
  recall({ query = '', symbol = null, limit = this.maxRecall } = {}) {
    const notes = query ? this.vault.search(query, { limit }).map((n) => ({ id: n.id, title: n.title, path: n.path, excerpt: n.excerpt, score: n.score, tags: n.tags })) : this.vault.list({ limit: Math.min(limit, 8) }).map((n) => ({ id: n.id, title: n.title, path: n.path, tags: n.tags }));

    let episodes = this.recent({ limit: 30 });
    if (query) {
      const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
      episodes = episodes.filter((e) => terms.some((t) => e.summary.toLowerCase().includes(t) || (e.symbol ?? '').toLowerCase().includes(t)));
    }
    if (symbol) episodes = episodes.filter((e) => e.symbol === symbol);
    episodes = episodes.sort((a, b) => b.importance - a.importance).slice(0, limit);

    return {
      notes,
      episodes: episodes.map((e) => ({ kind: e.kind, symbol: e.symbol, summary: e.summary, ts: e.ts, importance: e.importance })),
      profile: this.profile(null),
    };
  }

  /* --------------------------- conversations ---------------------------- */

  addTurn(userId, role, content) {
    const arr = this.conversations.get(userId) ?? [];
    arr.push({ role, content, ts: now() });
    // keep the last 40 turns per user; older context is in the vault anyway
    while (arr.length > 40) arr.shift();
    this.conversations.set(userId, arr);
    return arr;
  }

  history(userId, limit = 8) {
    return (this.conversations.get(userId) ?? []).slice(-limit);
  }

  /* ------------------------------ profiles ------------------------------ */

  /** Learn durable preferences from what the user does, not what they say. */
  observePreference(userId, key, value) {
    const p = this.profiles.get(userId) ?? { facts: {}, updatedAt: now() };
    if (p.facts[key] === value) return p;
    p.facts[key] = value;
    p.updatedAt = now();
    this.profiles.set(userId, p);
    return p;
  }

  profile(userId) {
    if (!userId) return null;
    return this.profiles.get(userId) ?? null;
  }

  /* ---------------------------- consolidation --------------------------- */

  /**
   * Turn episodes into vault notes. Called periodically; cheap and idempotent
   * per day because each note is keyed by date + symbol + kind and rewritten
   * rather than appended forever.
   */
  consolidate() {
    const since = this.lastConsolidation;
    const fresh = this.episodes.filter((e) => e.ts > since);
    if (fresh.length === 0) {
      return { written: 0, reason: 'nothing_new' };
    }
    let written = 0;
    const byKey = new Map();
    for (const e of fresh) {
      const key = `${e.kind}|${e.symbol ?? 'general'}|${dayKey(e.ts)}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(e);
    }

    for (const [key, group] of byKey) {
      const [kind, symbol, day] = key.split('|');
      if (group.length === 0) continue;

      // Make sure the hub notes exist first, otherwise every "Related" link is a
      // dangling reference and the graph never develops any edges.
      if (symbol && symbol !== 'general') this.ensureConcept(`Symbols/${symbol}`, symbol, ['symbol', symbol.toLowerCase()], `Instrument hub for **${symbol}**`);
      this.ensureConcept(`Playbooks/${labelFor(kind)}`, labelFor(kind), ['playbook', kind.toLowerCase()], `Everything the engine has learned about **${labelFor(kind).toLowerCase()}** setups`);

      const title = `${labelFor(kind)} · ${symbol} · ${day}`;
      const path = `${folderFor(kind)}/${sanitise(title)}.md`;
      const existing = this.vault.getByTitle(title);
      const lines = group
        .sort((a, b) => a.ts - b.ts)
        .map((e) => `- **${clock(e.ts)}** ${e.summary}${e.tags.length ? ` ${e.tags.map((t) => `#${t}`).join(' ')}` : ''}`);

      const related = [...new Set([
        ...(symbol && symbol !== 'general' ? [symbol] : []),
        labelFor(kind),
        ...group.flatMap((e) => e.tags),
      ])];
      const body = [
        `# ${title}`,
        '',
        `Consolidated from ${group.length} observation${group.length === 1 ? '' : 's'} on ${day}.`,
        '',
        '## Observations',
        ...lines,
        related.length ? `\n## Related\n${related.map((t) => `- [[${t}]]`).join('\n')}` : '',
        '',
        `_Auto-generated by the memory consolidator. Source: ${kind}._`,
      ]
        .filter(Boolean)
        .join('\n');

      const tags = [...new Set(group.flatMap((e) => e.tags))].concat([kind, symbol.toLowerCase().replace(/[^a-z0-9]+/g, '-')]);
      this.vault.write({
        path,
        content: existing ? body : `---\ntags: [${[...new Set(tags)].join(', ')}]\nsource: ${kind}\ngenerated: true\n---\n${body}`,
        title,
        tags,
        frontmatter: { generated: true, source: kind, symbol, day },
        source: kind === 'trade' ? 'trade' : kind === 'signal' ? 'signal' : 'ai',
      });
      written++;
    }

    this.lastConsolidation = now();
    this.counters.consolidated += written;
    return { written, episodes: fresh.length, groups: byKey.size };
  }

  /** Create a hub note once, so links into it resolve and the graph connects. */
  ensureConcept(path, title, tags, lede) {
    if (this.vault.resolve(title)) return false;
    this.vault.write({
      path: `${path}.md`,
      title,
      content: `# ${title}\n\n${lede}.\n\nThis note is a hub: dated records link here, so the graph stays navigable instead of fragmenting into orphans.\n`,
      tags,
      frontmatter: { concept: true, pinned: true },
      source: 'ai',
    });
    return true;
  }

  /* -------------------------------- stats ------------------------------- */

  stats() {
    const byKind = {};
    for (const e of this.episodes) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
    return {
      episodes: this.episodes.length,
      capacity: this.maxEpisodes,
      byKind,
      conversations: this.conversations.size,
      lastConsolidation: this.lastConsolidation,
      counters: { ...this.counters },
      vault: { notes: this.vault.notes.size, edges: this.vault.edges.size, bytes: this.vault.stats.bytes },
    };
  }

  clear() {
    this.episodes = [];
    this.conversations.clear();
    this.profiles.clear();
    this.counters = { recorded: 0, consolidated: 0, dropped: 0 };
    this.lastConsolidation = 0;
  }
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, Number(v) || 0));
}
function labelFor(kind) {
  return { signal: 'Signal', trade: 'Trade', question: 'Question', insight: 'Insight', regime: 'Regime', risk: 'Risk' }[kind] ?? 'Note';
}
function folderFor(kind) {
  return { signal: 'Signals', trade: 'Trades', question: 'Questions', insight: 'Insights', regime: 'Regimes', risk: 'Risk' }[kind] ?? 'Notes';
}
function clock(ts) {
  return new Date(ts).toISOString().slice(11, 19);
}
function sanitise(s) {
  return s.replace(/[\\/:*?"<>|]/g, '-').replace(/\s+/g, ' ').trim();
}
function relatedTitles(episode) {
  const t = [];
  if (episode.symbol) t.push(episode.symbol);
  for (const tag of episode.tags ?? []) t.push(tag);
  return t;
}
