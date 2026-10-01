// Shared helpers for the vendor license tools. No secrets live in this file.
import { createHash, createPublicKey } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
export const PUBLIC_KEY_TS = process.env.SBM_PUBLIC_KEY_TS || join(REPO_ROOT, 'src/main/license/public-key.ts');
/** Default home of the vendor's private key: OUTSIDE any repository, in the user's profile. */
export const DEFAULT_KEY_DIR = process.env.SBM_VENDOR_KEY_DIR || join(homedir(), '.sabermarko-vendor-keys');
export const DEFAULT_PRIVATE_KEY = join(DEFAULT_KEY_DIR, 'private.pem');

export function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const k = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[k] = true; else { out[k] = next; i++; }
  }
  return out;
}

/** The public key the application embeds (src/main/license/public-key.ts). */
export function embeddedPublicKeyPem() {
  const src = readFileSync(PUBLIC_KEY_TS, 'utf8');
  const m = src.match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/);
  if (!m) throw new Error(`no public key found in ${PUBLIC_KEY_TS}`);
  return m[0];
}

/** Short, printable fingerprint of a public key (sha256 of its DER encoding). */
export function fingerprint(publicPem) {
  const der = createPublicKey(publicPem).export({ type: 'spki', format: 'der' });
  return createHash('sha256').update(der).digest('hex').slice(0, 32).match(/.{4}/g).join(':');
}

/** True when `p` is inside a git working tree (any repository, not only this one). */
export function insideGitRepo(p) {
  const abs = resolve(p);
  if (abs === REPO_ROOT || abs.startsWith(REPO_ROOT + sep)) return true;
  try {
    execFileSync('git', ['-C', abs, 'rev-parse', '--is-inside-work-tree'], { stdio: ['ignore', 'pipe', 'ignore'] });
    return true;
  } catch { return false; }
}

export const b64u = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
export const b64uDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4), 'base64');
export const EDITIONS = ['basic', 'standard', 'professional'];
