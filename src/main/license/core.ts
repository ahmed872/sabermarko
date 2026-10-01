import { createHash, createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

/**
 * Licensing core (pure, testable).
 *
 * - Paid licenses are Ed25519-signed by the vendor. The app only holds the
 *   PUBLIC key, so keys cannot be forged from the app binary.
 * - Licenses are bound to a machine code (hash of the OS machine id) unless
 *   issued for '*'.
 * - Trial start is stored in several independent places, each HMAC-sealed with
 *   a machine-derived key. The earliest valid record wins; a record that fails
 *   its seal is treated as tampering.
 * - Clock rollback is detected by tracking the latest time ever observed.
 * - Activation is fully offline: no internet is needed to sell.
 */

export const TRIAL_DAYS = 20;
export const CLOCK_TOLERANCE_MS = 6 * 3600_000;
const DAY = 86_400_000;
const SEAL_SECRET = 'sbm-pos/seal/v1/7f3c9a52e1';

export type LicenseType = 'trial' | 'temporary' | 'permanent';

export interface LicensePayload {
  v: 1;
  id: string;
  type: 'temporary' | 'permanent';
  customer: string;
  machine: string; // machine code or '*'
  issued: string; // YYYY-MM-DD
  expires: string | null; // YYYY-MM-DD (inclusive) for temporary
}

export interface StoredState {
  installId: string;
  trialStart: number; // epoch ms
  lastSeen: number; // epoch ms (max ever observed)
  licenseKey?: string | null;
}

export interface SealedRecord { data: StoredState; seal: string }

export interface LicenseStorage {
  /** Returns every stored record found (file, registry/home mirror, database). */
  readAll(): (SealedRecord | null | 'corrupt')[];
  writeAll(rec: SealedRecord): void;
}

export interface LicenseStatus {
  state: 'trial' | 'licensed' | 'expired' | 'tampered' | 'clock';
  type: LicenseType;
  canOperate: boolean;
  daysLeft: number | null;
  trialEndsAt: string | null;
  expiresAt: string | null;
  customer: string | null;
  licenseId: string | null;
  machineCode: string;
  message?: string;
}

export function formatMachineCode(rawMachineId: string, appId: string): string {
  const h = createHash('sha256').update(`${appId}|${rawMachineId.trim().toLowerCase()}`).digest('hex').slice(0, 20).toUpperCase();
  return h.match(/.{1,5}/g)!.join('-');
}

function sealKey(machineCode: string): Buffer {
  return createHash('sha256').update(`${SEAL_SECRET}|${machineCode}`).digest();
}

export function seal(data: StoredState, machineCode: string): SealedRecord {
  const body = JSON.stringify([data.installId, data.trialStart, data.lastSeen, data.licenseKey ?? null]);
  return { data, seal: createHmac('sha256', sealKey(machineCode)).update(body).digest('base64') };
}

export function verifySeal(rec: SealedRecord, machineCode: string): boolean {
  try {
    const expected = Buffer.from(seal(rec.data, machineCode).seal, 'base64');
    const actual = Buffer.from(String(rec.seal), 'base64');
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

function b64urlDecode(s: string): Buffer {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export type ParseResult = { ok: true; payload: LicensePayload } | { ok: false; error: 'LICENSE_INVALID' | 'LICENSE_WRONG_MACHINE' | 'LICENSE_EXPIRED' };

export function parseLicenseKey(key: string, publicKeyPem: string, machineCode: string, nowMs: number): ParseResult {
  const clean = String(key ?? '').replace(/\s+/g, '');
  const parts = clean.split('.');
  if (parts.length !== 3 || parts[0] !== 'SBM1') return { ok: false, error: 'LICENSE_INVALID' };
  let payload: LicensePayload;
  try {
    const data = b64urlDecode(parts[1]);
    const sig = b64urlDecode(parts[2]);
    const pub = createPublicKey(publicKeyPem);
    if (!verify(null, Buffer.concat([Buffer.from('SBM1.'), data]), pub, sig)) return { ok: false, error: 'LICENSE_INVALID' };
    payload = JSON.parse(data.toString('utf8'));
  } catch {
    return { ok: false, error: 'LICENSE_INVALID' };
  }
  if (payload.v !== 1 || !['temporary', 'permanent'].includes(payload.type)) return { ok: false, error: 'LICENSE_INVALID' };
  if (payload.machine !== '*' && payload.machine !== machineCode) return { ok: false, error: 'LICENSE_WRONG_MACHINE' };
  if (payload.type === 'temporary') {
    if (!payload.expires) return { ok: false, error: 'LICENSE_INVALID' };
    if (endOfDay(payload.expires) < nowMs) return { ok: false, error: 'LICENSE_EXPIRED' };
  }
  return { ok: true, payload };
}

function endOfDay(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}

function isoDate(ms: number): string {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class LicenseManager {
  private state: StoredState | null = null;
  private tampered = false;

  constructor(
    private storage: LicenseStorage,
    private machineCode: string,
    private publicKeyPem: string,
    private clock: () => number,
    private newId: () => string,
    /** latest business timestamp found in the database (sales etc.) */
    private latestDataTime: () => number = () => 0,
  ) {}

  /** Load and reconcile all stored records. Creates the trial on first ever run. */
  load(): void {
    const recs = this.storage.readAll();
    const valid: StoredState[] = [];
    for (const r of recs) {
      if (r === null) continue;
      if (r === 'corrupt' || !verifySeal(r, this.machineCode)) { this.tampered = true; continue; }
      valid.push(r.data);
    }
    const now = this.clock();
    if (!valid.length) {
      if (this.tampered) {
        // all records were altered: do not grant a fresh trial
        this.state = { installId: this.newId(), trialStart: now - (TRIAL_DAYS + 1) * DAY, lastSeen: now, licenseKey: null };
      } else {
        this.state = { installId: this.newId(), trialStart: now, lastSeen: now, licenseKey: null };
      }
    } else {
      const trialStart = Math.min(...valid.map((v) => v.trialStart));
      const lastSeen = Math.max(...valid.map((v) => v.lastSeen));
      const withKey = valid.find((v) => v.licenseKey) ?? null;
      this.state = { installId: valid[0].installId, trialStart, lastSeen, licenseKey: withKey?.licenseKey ?? null };
    }
    this.persist();
  }

  private persist(): void {
    if (!this.state) return;
    this.storage.writeAll(seal(this.state, this.machineCode));
  }

  /** Record that time moved forward (call periodically). Never moves lastSeen backwards. */
  touch(): void {
    if (!this.state) this.load();
    const now = this.clock();
    if (now > this.state!.lastSeen) {
      this.state!.lastSeen = now;
      this.persist();
    }
  }

  status(): LicenseStatus {
    if (!this.state) this.load();
    const s = this.state!;
    const now = this.clock();
    const base = { machineCode: this.machineCode, customer: null, licenseId: null, expiresAt: null, trialEndsAt: null } as const;
    const highWater = Math.max(s.lastSeen, this.latestDataTime());
    if (now + CLOCK_TOLERANCE_MS < highWater) {
      return { ...base, state: 'clock', type: 'trial', canOperate: false, daysLeft: null };
    }
    if (s.licenseKey) {
      const res = parseLicenseKey(s.licenseKey, this.publicKeyPem, this.machineCode, Math.max(now, s.lastSeen));
      if (res.ok) {
        const p = res.payload;
        const daysLeft = p.type === 'temporary' && p.expires ? Math.max(0, Math.ceil((endOfDay(p.expires) - now) / DAY)) : null;
        return { ...base, state: 'licensed', type: p.type, canOperate: true, daysLeft, expiresAt: p.expires, customer: p.customer, licenseId: p.id };
      }
      if (res.error === 'LICENSE_EXPIRED') {
        const p = JSON.parse(b64urlDecode(s.licenseKey.split('.')[1]).toString('utf8')) as LicensePayload;
        return { ...base, state: 'expired', type: 'temporary', canOperate: false, daysLeft: 0, expiresAt: p.expires, customer: p.customer, licenseId: p.id };
      }
      // invalid/wrong machine key stored: fall through to trial evaluation but mark tamper
      this.tampered = true;
    }
    const trialEnd = s.trialStart + TRIAL_DAYS * DAY;
    const trialEndsAt = isoDate(trialEnd);
    if (this.tampered) {
      return { ...base, state: 'tampered', type: 'trial', canOperate: false, daysLeft: 0, trialEndsAt };
    }
    const effectiveNow = Math.max(now, s.lastSeen);
    const daysLeft = Math.max(0, Math.ceil((trialEnd - effectiveNow) / DAY));
    if (effectiveNow >= trialEnd) return { ...base, state: 'expired', type: 'trial', canOperate: false, daysLeft: 0, trialEndsAt };
    return { ...base, state: 'trial', type: 'trial', canOperate: true, daysLeft, trialEndsAt };
  }

  activate(key: string): ParseResult {
    if (!this.state) this.load();
    const now = Math.max(this.clock(), this.state!.lastSeen);
    const res = parseLicenseKey(key, this.publicKeyPem, this.machineCode, now);
    if (!res.ok) return res;
    this.state!.licenseKey = String(key).replace(/\s+/g, '');
    this.tampered = false;
    this.persist();
    return res;
  }
}
