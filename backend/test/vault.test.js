import test from 'node:test';
import assert from 'node:assert/strict';
import { Vault } from '../src/vault/vault.js';
import { Memory } from '../src/vault/memory.js';

test('wikilinks build backlinks and search finds notes', () => {
  const v = new Vault();
  const a = v.write({ path: 'A.md', title: 'Alpha', content: '# Alpha\n\nSee [[Beta]] for sizing.' });
  const b = v.write({ path: 'B.md', title: 'Beta', content: '# Beta\n\nPosition sizing note. #risk' });
  assert.equal(v.backlinks(b.id).length, 1);
  assert.equal(v.outgoing(a.id).length, 1);
  assert.ok(v.search('sizing').length >= 1);
  assert.ok(v.get(b.id).tags.includes('risk'));
});

test('a note keeps its owner across an update by path', () => {
  const v = new Vault();
  const n = v.write({ path: 'Mine.md', content: 'first', owner: 'lic_a' });
  v.write({ path: 'Mine.md', content: 'second' });
  const got = v.get(n.id);
  assert.equal(got.owner, 'lic_a');
  assert.equal(got.body.trim(), 'second');
  assert.equal(v.snapshot().notes[0].owner, undefined, 'owner is not part of the public listing');
});

test('memory caps are respected and consolidation writes notes', () => {
  const v = new Vault({ maxNotes: 50 });
  const m = new Memory({ vault: v, maxEpisodes: 5 });
  for (let i = 0; i < 12; i++) m.record({ kind: 'signal', symbol: 'X', summary: `episode ${i}`, tags: ['t'] });
  assert.ok(m.stats().episodes <= 5);
  const r = m.consolidate();
  assert.ok(typeof r.written === 'number');
});
