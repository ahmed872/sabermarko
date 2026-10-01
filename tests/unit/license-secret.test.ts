import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLicenseKey } from '../../src/main/license/core';

// The GitHub path (repository secret → make-key.yml / release.yml): tools/license/use-secret-key.mjs builds the
// PUBLIC half of the secret into the app, and tools/license/issue.mjs signs codes with the secret — so a code
// issued from GitHub is always accepted by an installer built from the same secret.
const MACHINE = '9F2C1-0B7A4-33D10-AA0F2';
const run = (script: string, args: string[], env: Record<string, string>) =>
  spawnSync(process.execPath, [join('tools/license', script), ...args], { encoding: 'utf8', env: { ...process.env, ...env } });

describe('license key from the repository secret', () => {
  it('derives the public key, issues a code the app accepts, and never prints the secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbm-secret-'));
    const pubTs = join(dir, 'public-key.ts');
    const keyOut = join(dir, 'vendor.pem');
    const { privateKey, publicKey } = generateKeyPairSync('ed25519');
    const secret = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    const r = run('use-secret-key.mjs', ['--key-out', keyOut], { SBM_LICENSE_PRIVATE_KEY: secret, SBM_PUBLIC_KEY_TS: pubTs });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout + r.stderr).not.toContain(secret.split('\n')[1]);
    const appPub = readFileSync(pubTs, 'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)![0];
    expect(appPub).toBe(publicKey.export({ type: 'spki', format: 'pem' }).toString().trim());
    if (process.platform !== 'win32') expect(statSync(keyOut).mode & 0o077).toBe(0);

    const issued = run('issue.mjs', ['--key', keyOut, '--machine', MACHINE, '--customer', 'مطعم النيل', '--type', 'permanent', '--edition', 'basic'], { SBM_PUBLIC_KEY_TS: pubTs });
    expect(issued.status, issued.stderr).toBe(0);
    const code = issued.stdout.trim();
    const p = parseLicenseKey(code, appPub, MACHINE, Date.now());
    expect(p.ok).toBe(true);
    if (p.ok) expect(p.payload).toMatchObject({ type: 'permanent', customer: 'مطعم النيل', machine: MACHINE, edition: 'basic' });
    // the repository's development key does NOT accept it
    const repoPub = readFileSync('src/main/license/public-key.ts', 'utf8').match(/-----BEGIN PUBLIC KEY-----[\s\S]+?-----END PUBLIC KEY-----/)![0];
    expect(parseLicenseKey(code, repoPub, MACHINE, Date.now())).toEqual({ ok: false, error: 'LICENSE_INVALID' });
  });

  it('accepts a secret pasted with literal \\n, and refuses a missing or invalid secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'sbm-secret-'));
    const pubTs = join(dir, 'public-key.ts');
    const secret = generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(run('use-secret-key.mjs', [], { SBM_LICENSE_PRIVATE_KEY: secret.replace(/\n/g, '\\n'), SBM_PUBLIC_KEY_TS: pubTs }).status).toBe(0);

    const missing = run('use-secret-key.mjs', [], { SBM_LICENSE_PRIVATE_KEY: '', SBM_PUBLIC_KEY_TS: pubTs });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('SBM_LICENSE_PRIVATE_KEY');
    expect(run('use-secret-key.mjs', ['--optional'], { SBM_LICENSE_PRIVATE_KEY: '', SBM_PUBLIC_KEY_TS: pubTs }).status).toBe(0);
    expect(run('use-secret-key.mjs', [], { SBM_LICENSE_PRIVATE_KEY: 'not a key', SBM_PUBLIC_KEY_TS: pubTs }).status).toBe(2);
    const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    expect(run('use-secret-key.mjs', [], { SBM_LICENSE_PRIVATE_KEY: rsa, SBM_PUBLIC_KEY_TS: pubTs }).status).toBe(2);
  });
});
