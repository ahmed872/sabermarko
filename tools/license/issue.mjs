// Issue a signed license key.
// node tools/license/issue.mjs --machine XXXXX-XXXXX-XXXXX-XXXXX --customer "سوبر ماركت البركة" --type temporary --days 365
// node tools/license/issue.mjs --machine XXXXX-... --customer "..." --type permanent
import { createPrivateKey, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, v, i, arr) => (v.startsWith('--') ? [...acc, [v.slice(2), arr[i + 1]]] : acc), []));
const keyFile = args.key || process.env.SBM_LICENSE_PRIVATE_KEY || '.vendor-keys/private.pem';
const type = args.type || 'temporary';
if (!args.machine || !args.customer || !['temporary', 'permanent'].includes(type)) {
  console.error('Usage: --machine <code|*> --customer <name> --type temporary|permanent [--days N | --expires YYYY-MM-DD]');
  process.exit(1);
}
const today = new Date();
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
let expires = null;
if (type === 'temporary') {
  if (args.expires) expires = args.expires;
  else { const d = new Date(today); d.setDate(d.getDate() + Number(args.days || 30)); expires = iso(d); }
}
const payload = { v: 1, id: randomUUID().slice(0, 8), type, customer: args.customer, machine: args.machine.toUpperCase(), issued: iso(today), expires };
const data = Buffer.from(JSON.stringify(payload), 'utf8');
const sig = sign(null, Buffer.concat([Buffer.from('SBM1.'), data]), createPrivateKey(readFileSync(keyFile)));
const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
console.log(`SBM1.${b64u(data)}.${b64u(sig)}`);
console.error(JSON.stringify(payload));
