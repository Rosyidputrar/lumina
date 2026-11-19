/**
 * Mint a licence key from the command line.
 *
 *   npm run seed                          # a 7-day trial key
 *   npm run seed -- --plan monthly --label "Aisyah's phone"
 *   npm run seed -- --plan lifetime --quota 0   (0 = unlimited quota)
 *
 * It writes to the same database the server uses (LUMINA_DB) and signs with
 * the same LUMINA_LICENSE_SECRET, so the printed key activates that server.
 */
import { config } from '../config.js';
import { Store } from '../store.js';
import { Licensing, PLANS } from '../licensing/licence.js';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
}

const plan = arg('plan', 'trial');
if (!PLANS[plan]) {
  console.error(`unknown plan "${plan}"; choose one of ${Object.keys(PLANS).join(', ')}`);
  process.exit(1);
}
const quotaArg = arg('quota');
const daysArg = arg('days');
const quota = quotaArg === null ? null : Number(quotaArg) === 0 ? null : Number(quotaArg);
const days = daysArg === null ? null : Number(daysArg);

const store = new Store(config.dbFile);
try {
  const licensing = new Licensing({ store, secret: config.licence.secret, adminSecret: config.licence.ownerSecret });
  const issued = licensing.issue({ plan, label: arg('label', 'Seeded from CLI'), quota: quotaArg === null ? null : quota, days });
  if (quotaArg !== null && Number(quotaArg) === 0) licensing.setQuota(issued.keyId, null);
  store.audit({ userId: null, actor: 'cli', action: 'licence_issued', detail: { keyId: issued.keyId, plan }, ip: null });
  console.log('');
  console.log(`  plan      ${issued.plan}`);
  console.log(`  quota     ${quotaArg !== null && Number(quotaArg) === 0 ? 'unlimited' : issued.quota ?? 'unlimited'}`);
  console.log(`  expires   ${issued.expiresAt ? new Date(issued.expiresAt).toISOString().slice(0, 10) : 'never'}`);
  console.log(`  database  ${config.dbFile}`);
  console.log('');
  console.log(`  key       ${issued.readableKey}`);
  console.log('');
} finally {
  store.close();
}
