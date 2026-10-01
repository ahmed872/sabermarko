import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { LicenseStorage, SealedRecord } from './core';
import type { DB } from '../db/connection';

/** Raw OS machine identifier (not shown to users; hashed into the machine code). */
export function rawMachineId(fallbackFile: string): string {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
      const m = out.match(/MachineGuid\s+REG_SZ\s+([\w-]+)/i);
      if (m) return m[1];
    } else if (process.platform === 'darwin') {
      const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 });
      const m = out.match(/"IOPlatformUUID" = "([^"]+)"/);
      if (m) return m[1];
    } else {
      for (const f of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
        if (existsSync(f)) {
          const v = readFileSync(f, 'utf8').trim();
          if (v) return v;
        }
      }
    }
  } catch { /* fall back below */ }
  // Fallback: persistent random id
  try {
    if (existsSync(fallbackFile)) return readFileSync(fallbackFile, 'utf8').trim();
  } catch { /* ignore */ }
  const id = randomUUID();
  mkdirSync(dirname(fallbackFile), { recursive: true });
  writeFileSync(fallbackFile, id);
  return id;
}

function atomicWrite(file: string, data: string) {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
}

function parse(text: string | null): SealedRecord | null | 'corrupt' {
  if (text === null) return null;
  try {
    const r = JSON.parse(Buffer.from(text.trim(), 'base64').toString('utf8'));
    if (!r || typeof r !== 'object' || !r.data || !r.seal) return 'corrupt';
    return r as SealedRecord;
  } catch {
    return 'corrupt';
  }
}

const encode = (rec: SealedRecord) => Buffer.from(JSON.stringify(rec), 'utf8').toString('base64');

const REG_KEY = 'HKCU\\Software\\SaberMarkoPOS';

/**
 * Three independent stores: a file in userData, an OS-level mirror that
 * survives uninstall (registry on Windows, hidden file in the home folder
 * elsewhere), and the database itself.
 */
export function createNodeLicenseStorage(userDataDir: string, getDb: () => DB | null, appId: string, mirrorDirOverride?: string | null): LicenseStorage {
  const primary = join(userDataDir, 'license.dat');
  const tag = createHash('sha256').update(appId).digest('hex').slice(0, 10);
  const homeMirror = join(mirrorDirOverride ?? join(homedir(), process.platform === 'darwin' ? 'Library/Application Support' : '.local/share'), `.sbm-${tag}`);
  const useRegistry = process.platform === 'win32' && !mirrorDirOverride;
  const readFile = (f: string) => { try { return existsSync(f) ? readFileSync(f, 'utf8') : null; } catch { return null; } };
  const readMirror = (): string | null => {
    if (useRegistry) {
      try {
        const out = execFileSync('reg', ['query', REG_KEY, '/v', 'ls'], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
        const m = out.match(/ls\s+REG_SZ\s+(\S+)/);
        return m ? m[1] : null;
      } catch { return null; }
    }
    return readFile(homeMirror);
  };
  const writeMirror = (v: string) => {
    if (useRegistry) {
      try { execFileSync('reg', ['add', REG_KEY, '/v', 'ls', '/t', 'REG_SZ', '/d', v, '/f'], { windowsHide: true, timeout: 5000 }); } catch { /* best effort */ }
      return;
    }
    try { atomicWrite(homeMirror, v); } catch { /* best effort */ }
  };
  return {
    readAll() {
      const db = getDb();
      let dbVal: string | null = null;
      if (db) {
        try { dbVal = (db.prepare(`SELECT value FROM app_meta WHERE key = 'ls'`).get() as { value: string } | undefined)?.value ?? null; } catch { dbVal = null; }
      }
      return [parse(readFile(primary)), parse(readMirror()), parse(dbVal)];
    },
    writeAll(rec) {
      const v = encode(rec);
      try { atomicWrite(primary, v); } catch { /* best effort */ }
      writeMirror(v);
      const db = getDb();
      if (db) {
        try { db.prepare(`INSERT INTO app_meta(key, value) VALUES ('ls', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).run(v); } catch { /* ignore */ }
      }
    },
  };
}
