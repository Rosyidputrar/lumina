import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { startApp, client } from './helpers.js';

test('with no owner secret, a cookie signed with an empty key is not an owner session', async () => {
  const app = await startApp({ ownerSecret: '' });
  try {
    const ts = Date.now();
    const forged = `owner.${ts}.${crypto.createHmac('sha256', '').update(`owner.${ts}`).digest('base64url')}`;
    const r = await fetch(app.base + '/api/owner/licences', { headers: { cookie: `lumina_owner=${forged}` } });
    assert.equal(r.status, 401);
    const s = await fetch(app.base + '/api/owner/session', { headers: { cookie: `lumina_owner=${forged}` } });
    assert.equal((await s.json()).authenticated, false);
    assert.equal((await client(app.base).post('/api/owner/login', { passphrase: '' })).status, 401);
  } finally {
    await app.close();
  }
});
