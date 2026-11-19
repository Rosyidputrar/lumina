import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Licensing } from '../src/licensing/licence.js';

const make = () => new Licensing({ store: new Store(':memory:'), secret: 'a-signing-secret-of-decent-length', adminSecret: 'owner-pass' });

test('a short signing secret is refused', () => {
  assert.throws(() => new Licensing({ store: new Store(':memory:'), secret: 'short' }));
});

test('issued keys validate in both the signed and the readable form', () => {
  const lic = make();
  const k = lic.issue({ plan: 'monthly', label: 'phone' });
  assert.match(k.readableKey, /^LV-[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  for (const key of [k.key, k.readableKey, k.readableKey.toLowerCase()]) {
    const v = lic.validate(key);
    assert.equal(v.ok, true, key);
    assert.equal(v.plan, 'monthly');
    assert.equal(v.quota, 5000);
    assert.equal(v.label, 'phone');
  }
});

test('a tampered signature or payload is rejected', () => {
  const lic = make();
  const { key } = lic.issue({ plan: 'trial' });
  const [p, payload, sig] = key.split('.');
  assert.deepEqual(lic.validate(`${p}.${payload}.${sig.slice(0, -2)}xx`).reasons, ['bad_signature']);
  const forged = Buffer.from(JSON.stringify({ k: 'x', p: 'lifetime', q: null, e: null })).toString('base64url');
  assert.deepEqual(lic.validate(`${p}.${forged}.${sig}`).reasons, ['bad_signature']);
  assert.deepEqual(lic.validate('nonsense').reasons, ['malformed']);
  assert.deepEqual(lic.validate('LV-AAAAA-AAAAA-AAAAA-AAAAA').reasons, ['unknown_key']);
  assert.deepEqual(lic.validate('').reasons, ['missing']);
});

test('quota is consumed and enforced', () => {
  const lic = make();
  const k = lic.issue({ plan: 'trial', quota: 5 });
  assert.equal(lic.consume(k.key, 3).remaining, 2);
  assert.equal(lic.consume(k.key, 3).ok, false);
  assert.equal(lic.consume(k.key, 2).ok, true);
  assert.deepEqual(lic.validate(k.key).reasons, ['quota_exhausted']);
  lic.setQuota(k.keyId, 20);
  assert.equal(lic.validate(k.key).remaining, 15);
  lic.resetUsage(k.keyId);
  assert.equal(lic.validate(k.key).used, 0);
});

test('revoke, restore, expiry and extension are honoured', () => {
  const lic = make();
  const k = lic.issue({ plan: 'trial', days: 1 });
  lic.revoke(k.keyId, true);
  assert.deepEqual(lic.validate(k.key).reasons, ['revoked']);
  lic.revoke(k.keyId, false);
  assert.equal(lic.validate(k.key).ok, true);
  lic.store.run('UPDATE licences SET expires_at = ? WHERE key_id = ?', Date.now() - 1000, k.keyId);
  assert.deepEqual(lic.validate(k.key).reasons, ['expired']);
  lic.extend(k.keyId, 10);
  const v = lic.validate(k.key);
  assert.equal(v.ok, true);
  assert.ok(v.daysLeft >= 9 && v.daysLeft <= 10);
});

test('owner passphrase check is exact and disabled when empty', () => {
  const lic = make();
  assert.equal(lic.checkOwner('owner-pass'), true);
  assert.equal(lic.checkOwner('owner-pas'), false);
  const none = new Licensing({ store: new Store(':memory:'), secret: 'a-signing-secret-of-decent-length', adminSecret: '' });
  assert.equal(none.checkOwner(''), false);
});

test('summary counts active, revoked and consumed', () => {
  const lic = make();
  const a = lic.issue({ plan: 'trial', quota: 10 });
  lic.issue({ plan: 'lifetime' });
  lic.consume(a.key, 4);
  lic.revoke(a.keyId);
  const s = lic.summary();
  assert.equal(s.total, 2);
  assert.equal(s.active, 1);
  assert.equal(s.revoked, 1);
  assert.equal(s.consumed, 4);
});
