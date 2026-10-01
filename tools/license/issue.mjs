// Issue a signed license key (run on the vendor's computer, where the private key lives).
//
//   npm run license:issue -- --machine 9F2C1-0B7A4-33D10-AA0F2 --customer "سوبر ماركت البركة" --type temporary --days 365
//   npm run license:issue -- --machine 9F2C1-... --customer "..." --type permanent --edition standard
//   npm run license:issue -- --machine 9F2C1-... --customer "..." --type permanent --max-users 8 --features multi-location
//
// Options: --key <private.pem> (default ~/.sabermarko-vendor-keys/private.pem or $SBM_LICENSE_PRIVATE_KEY)
//          --edition basic|standard|professional   --max-users N   --features a,b   --store "<store identity>"
// The new key is verified against the PUBLIC key embedded in the app before it is printed,
// so a key signed with the wrong private key can never reach a customer.
import { createPrivateKey, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DEFAULT_PRIVATE_KEY, EDITIONS, b64u, embeddedPublicKeyPem, fingerprint, parseArgs } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const keyFile = typeof args.key === 'string' ? args.key : process.env.SBM_LICENSE_PRIVATE_KEY || DEFAULT_PRIVATE_KEY;
const type = typeof args.type === 'string' ? args.type : 'temporary';
const usage = 'Usage: --machine <code|*> --customer <name> --type temporary|permanent [--days N | --expires YYYY-MM-DD] [--edition basic|standard|professional] [--max-users N] [--features a,b] [--store "..."]';
if (typeof args.machine !== 'string' || typeof args.customer !== 'string' || !['temporary', 'permanent'].includes(type)) { console.error(usage); process.exit(1); }
if (args.edition !== undefined && !EDITIONS.includes(args.edition)) { console.error(`--edition must be one of: ${EDITIONS.join(', ')}`); process.exit(1); }
const maxUsers = args['max-users'] !== undefined ? Number(args['max-users']) : undefined;
if (maxUsers !== undefined && (!Number.isInteger(maxUsers) || maxUsers < 1 || maxUsers > 100)) { console.error('--max-users must be a whole number between 1 and 100'); process.exit(1); }
if (!existsSync(keyFile)) { console.error(`Private key not found: ${keyFile}\nGenerate it on this computer with: npm run license:keygen`); process.exit(1); }

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = new Date();
let expires = null;
if (type === 'temporary') {
  if (typeof args.expires === 'string') expires = args.expires;
  else { const d = new Date(today); d.setDate(d.getDate() + Number(args.days || 30)); expires = iso(d); }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(expires)) { console.error('--expires must be YYYY-MM-DD'); process.exit(1); }
}
const payload = {
  v: 1, id: randomUUID().slice(0, 8), type, customer: args.customer, machine: args.machine.toUpperCase(), issued: iso(today), expires,
  ...(args.edition ? { edition: args.edition } : {}),
  ...(maxUsers !== undefined ? { maxUsers } : {}),
  ...(typeof args.features === 'string' ? { features: args.features.split(',').map((x) => x.trim()).filter(Boolean) } : {}),
  ...(typeof args.store === 'string' ? { store: args.store } : {}),
};
const data = Buffer.from(JSON.stringify(payload), 'utf8');
const signed = Buffer.concat([Buffer.from('SBM1.'), data]);
const privateKey = createPrivateKey({ key: readFileSync(keyFile), passphrase: process.env.SBM_KEY_PASSPHRASE || undefined });
const sig = sign(null, signed, privateKey);
const appPub = embeddedPublicKeyPem();
if (!verify(null, signed, createPublicKey(appPub), sig)) {
  const mine = fingerprint(createPublicKey(privateKey).export({ type: 'spki', format: 'pem' }).toString());
  console.error(`REFUSED: this private key (fingerprint ${mine}) does not match the public key built into the app (${fingerprint(appPub)}).\nThe customer's program would reject this license.`);
  process.exit(3);
}
console.log(`SBM1.${b64u(data)}.${b64u(sig)}`);
console.error(JSON.stringify(payload));
