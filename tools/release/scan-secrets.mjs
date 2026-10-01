// Blocks private keys, certificates and passwords from entering the repository.
//   node tools/release/scan-secrets.mjs --staged   (pre-commit hook: only files being committed)
//   node tools/release/scan-secrets.mjs            (CI / release: every tracked file)
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, statSync } from 'node:fs';

const staged = process.argv.includes('--staged');
const list = (a) => execFileSync('git', a, { encoding: 'utf8' }).split('\n').filter(Boolean);
const files = staged ? list(['diff', '--cached', '--name-only', '--diff-filter=ACMR']) : list(['ls-files']);

// assembled at runtime so this file does not match itself
const BEGIN = '-----BEGIN ';
const contentRules = [
  [new RegExp(`${BEGIN}(?:ENCRYPTED |RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----`), 'private key block'],
  [/\bCSC_KEY_PASSWORD\s*[:=]\s*['"]?[^\s'"$]{4,}/, 'code-signing password'],
  [/\bSBM_KEY_PASSPHRASE\s*[:=]\s*['"]?[^\s'"$]{4,}/, 'license key passphrase'],
];
const nameRules = [
  [/(^|\/)\.vendor-keys\//, 'vendor key folder'],
  [/(^|\/)\.sabermarko-vendor-keys\//, 'vendor key folder'],
  [/\.(pem|key|p12|pfx|snk|keystore|jks)$/i, 'key / certificate file'],
  [/(^|\/)\.env(\..+)?$/, 'environment file'],
];
const findings = [];
for (const f of files) {
  for (const [re, why] of nameRules) if (re.test(f)) findings.push(`${f}: ${why}`);
  if (!existsSync(f) || statSync(f).size > 5_000_000) continue;
  const text = readFileSync(f, 'latin1');
  for (const [re, why] of contentRules) if (re.test(text)) findings.push(`${f}: contains a ${why}`);
}
if (findings.length) {
  console.error('ممنوع: ملفات سرية لا يجب أن تدخل المستودع / BLOCKED: secrets must never enter the repository:');
  for (const x of findings) console.error(`  - ${x}`);
  console.error('Keep the license private key outside the repository (default: ~/.sabermarko-vendor-keys/).');
  process.exit(1);
}
console.log(`secret scan: ${files.length} ${staged ? 'staged' : 'tracked'} files clean`);
