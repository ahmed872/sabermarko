// Check a license key against the PUBLIC key built into the app (no private key needed).
//   npm run license:verify -- SBM1.xxxxx.yyyyy [--machine 9F2C1-0B7A4-33D10-AA0F2]
import { createPublicKey, verify } from 'node:crypto';
import { b64uDecode, embeddedPublicKeyPem, fingerprint, parseArgs } from './common.mjs';

const args = parseArgs(process.argv.slice(2));
const key = process.argv.slice(2).find((a) => a.startsWith('SBM1.'));
if (!key) { console.error('Usage: license:verify -- SBM1.<payload>.<signature> [--machine CODE]'); process.exit(1); }
const [, d, s] = key.trim().split('.');
const pub = embeddedPublicKeyPem();
let payload;
try { payload = JSON.parse(b64uDecode(d).toString('utf8')); } catch { console.error('INVALID: not a SaberMarko license key'); process.exit(2); }
const ok = verify(null, Buffer.concat([Buffer.from('SBM1.'), b64uDecode(d)]), createPublicKey(pub), b64uDecode(s));
console.log(`app public key : ${fingerprint(pub)}`);
console.log(`signature      : ${ok ? 'VALID' : 'INVALID (signed by another key, or the key was edited)'}`);
console.log(`payload        : ${JSON.stringify(payload)}`);
console.log(`users limit    : ${payload.maxUsers ?? (payload.edition ? `edition ${payload.edition}` : 'default (10)')}`);
if (typeof args.machine === 'string') {
  const m = payload.machine === '*' || payload.machine === args.machine.toUpperCase();
  console.log(`machine        : ${m ? 'matches' : `DOES NOT match (${payload.machine})`}`);
  if (!m) process.exit(4);
}
if (payload.expires && payload.expires < new Date().toISOString().slice(0, 10)) console.log(`expiry         : EXPIRED on ${payload.expires}`);
process.exit(ok ? 0 : 3);
