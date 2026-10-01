import { app, BrowserWindow, dialog, ipcMain, Menu, session, shell, type IpcMainInvokeEvent } from 'electron';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { APP_ID, VENDOR } from '../shared/brand';
import { AppError } from '../shared/errors';
import { routes, toErrorPayload } from './api';
import { backupFileName, createBackup, listBackups, pruneBackups, restoreBackup, validateBackup } from './backup';
import { migrate, openDatabase, quickCheck, type DB } from './db/connection';
import { seedSystemData } from './db/seed';
import { LicenseManager, formatMachineCode, type LicenseStatus } from './license/core';
import { createNodeLicenseStorage, rawMachineId } from './license/node-store';
import { LICENSE_PUBLIC_KEY } from './license/public-key';
import { initLogger, log } from './logger';
import { htmlToPdf, listPrinters, printHtml } from './printing';
import { renderReceiptHtml, renderSimpleDoc } from './receipt';
import { type Ctx, type SessionUser, audit, getAllSettings, getSetting, requirePerm, setSettingRaw, ts } from './services/context';
import { closeDay } from './services/reports';
import { getReturn, getSale } from './services/sales';
import { authenticate, login, reloadUser } from './services/users';

/* ------------------------------------------------------------------ paths & single instance */

if (process.env.SBM_USER_DATA) app.setPath('userData', process.env.SBM_USER_DATA);
app.setAppUserModelId(APP_ID);

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const userData = app.getPath('userData');
const dataDir = join(userData, 'data');
const dbPath = join(dataDir, 'store.db');
const workDir = join(userData, 'work');
mkdirSync(dataDir, { recursive: true });
mkdirSync(workDir, { recursive: true });
initLogger(join(userData, 'logs'));
process.on('uncaughtException', (e) => log.error('uncaughtException', e));
process.on('unhandledRejection', (e) => log.error('unhandledRejection', e));

/* ------------------------------------------------------------------ state */

let db: DB | null = null;
let recoveryMode = false;
let currentUser: SessionUser | null = null;
let mainWindow: BrowserWindow | null = null;
let license: LicenseManager;
const pendingRestores = new Map<string, string>();

function openDb(): DB {
  const d = openDatabase(dbPath);
  migrate(d);
  seedSystemData(d);
  return d;
}

function initDatabase() {
  try {
    const existed = existsSync(dbPath);
    db = openDb();
    if (existed && !quickCheck(db)) {
      log.error('database quick_check failed — entering recovery mode');
      recoveryMode = true;
    }
  } catch (e) {
    log.error('failed to open database — entering recovery mode', e);
    recoveryMode = true;
    try { db?.close(); } catch { /* ignore */ }
    db = null;
  }
}

function latestDataTime(): number {
  if (!db) return 0;
  try {
    const r = db.prepare(`SELECT MAX(created_at) AS t FROM (SELECT MAX(created_at) AS created_at FROM sales UNION ALL SELECT MAX(created_at) FROM stock_movements)`).get() as { t: string | null };
    return r.t ? Date.parse(r.t) : 0;
  } catch { return 0; }
}

function initLicense() {
  const machineCode = formatMachineCode(rawMachineId(join(userData, '.mid')), APP_ID);
  license = new LicenseManager(createNodeLicenseStorage(userData, () => db, APP_ID), machineCode, LICENSE_PUBLIC_KEY, () => Date.now(), () => randomUUID(), latestDataTime);
  license.load();
  setInterval(() => { try { license.touch(); } catch (e) { log.warn('license touch failed', e); } }, 10 * 60_000).unref();
}

function licenseStatus(): LicenseStatus {
  try { return license.status(); } catch (e) {
    log.error('license status failed', e);
    return { state: 'tampered', type: 'trial', canOperate: false, daysLeft: 0, trialEndsAt: null, expiresAt: null, customer: null, licenseId: null, machineCode: '' };
  }
}

function makeCtx(user: SessionUser | null): Ctx {
  if (!db) throw new AppError('RESTORE_FAILED');
  return { db, user, now: () => new Date() };
}

/* ------------------------------------------------------------------ backups */

function backupDir(): string {
  const configured = db ? getSetting(db, 'backup.directory') : '';
  return configured || join(app.getPath('documents'), 'SaberMarko Backups');
}

async function doBackup(reason: 'manual' | 'auto' | 'day-close' | 'before-update', dest?: string) {
  if (!db) throw new AppError('BACKUP_FAILED');
  const storeName = getSetting(db, 'store.name');
  const file = dest ?? join(backupDir(), backupFileName(storeName));
  const info = await createBackup(db, file, { appVersion: app.getVersion(), storeName, reason });
  setSettingRaw(db, 'backup.lastAt', ts(makeCtx(null)));
  if (reason !== 'manual') pruneBackups(backupDir(), getSetting(db, 'backup.keep'));
  log.info(`backup created (${reason})`, file);
  return info;
}

async function maybeAutoBackup() {
  if (!db || recoveryMode || !getSetting(db, 'onboarding.done') || !getSetting(db, 'backup.auto')) return;
  const last = getSetting(db, 'backup.lastAt');
  const hours = last ? (Date.now() - Date.parse(last)) / 3_600_000 : Infinity;
  if (hours >= Math.max(1, getSetting(db, 'backup.frequencyHours'))) {
    try { await doBackup('auto'); } catch (e) { log.error('auto backup failed', e); }
  }
}

/* ------------------------------------------------------------------ printing helpers */

function vendorLine() { return `برنامج ${VENDOR.productNameAr}`; }

async function printOrPdf(html: string, mode: 'print' | 'pdf' | 'preview', fileName: string) {
  const settings = getAllSettings(db!);
  if (mode === 'preview') return { html };
  if (mode === 'pdf') {
    const res = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(app.getPath('documents'), fileName), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    writeFileSync(res.filePath, await htmlToPdf(html, settings['print.type']));
    return { file: res.filePath };
  }
  try {
    await printHtml(html, { paper: settings['print.type'], printerName: settings['print.printerName'], copies: settings['print.copies'] });
    return { printed: true };
  } catch (e) {
    log.error('print failed', e);
    throw new AppError('PRINT_FAILED');
  }
}

/* ------------------------------------------------------------------ IPC */

const LICENSE_EXEMPT_EXTRA = new Set(['app.boot', 'app.info', 'auth.login', 'auth.logout', 'license.status', 'license.activate', 'backup.create', 'backup.list', 'backup.openDir']);

function senderAllowed(e: IpcMainInvokeEvent): boolean {
  const url = e.senderFrame?.url ?? '';
  if (process.env.SBM_DEV_URL && url.startsWith(process.env.SBM_DEV_URL)) return true;
  return url.startsWith(pathToFileURL(join(__dirname, '../renderer')).href);
}

type Special = (payload: any, ctx: Ctx | null) => unknown | Promise<unknown>;

const special: Record<string, Special> = {
  'app.boot': () => {
    const lic = licenseStatus();
    if (recoveryMode || !db) return { recovery: true, license: lic, version: app.getVersion(), backups: listBackups(backupDir()).slice(0, 20) };
    const ctx = makeCtx(currentUser);
    if (currentUser) currentUser = reloadUser(ctx, currentUser.id);
    return {
      recovery: false,
      needsSetup: (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n === 0,
      license: lic,
      user: currentUser,
      settings: currentUser ? getAllSettings(db) : routes['settings.public'].fn(ctx, null),
      version: app.getVersion(),
      vendor: VENDOR,
    };
  },
  'app.info': () => ({ version: app.getVersion(), vendor: VENDOR, dataDir, backupDir: backupDir(), machineCode: licenseStatus().machineCode, electron: process.versions.electron, platform: process.platform }),
  'auth.login': (p) => {
    const ctx = makeCtx(null);
    currentUser = login(ctx, p.username, p.password);
    return { user: currentUser, settings: getAllSettings(db!) };
  },
  'auth.logout': () => {
    if (currentUser) audit(makeCtx(currentUser), 'auth.logout', 'user', currentUser.id);
    currentUser = null;
    return { ok: true };
  },
  'license.status': () => licenseStatus(),
  'license.activate': (p) => {
    const res = license.activate(String(p?.key ?? ''));
    if (!res.ok) throw new AppError(res.error);
    if (db) audit(makeCtx(currentUser), 'license.activate', 'license', null, undefined, { id: res.payload.id, type: res.payload.type, expires: res.payload.expires });
    return licenseStatus();
  },
  'day.close': async (p, ctx) => {
    const result = closeDay(ctx!, p?.date);
    if (getSetting(db!, 'backup.onDayClose')) {
      try {
        const info = await doBackup('day-close');
        db!.prepare('UPDATE day_closings SET backup_file = ? WHERE id = ?').run(info.file, result.id);
      } catch (e) { log.error('day-close backup failed', e); }
    }
    return result;
  },
  'backup.create': async (_p, ctx) => { requirePerm(ctx!, 'backup.manage'); return doBackup('manual'); },
  'backup.createAs': async (_p, ctx) => {
    requirePerm(ctx!, 'backup.manage');
    const res = await dialog.showSaveDialog(mainWindow!, { defaultPath: join(backupDir(), backupFileName(getSetting(db!, 'store.name'))), filters: [{ name: 'نسخة احتياطية', extensions: ['sbmbak'] }] });
    if (res.canceled || !res.filePath) return { canceled: true };
    return doBackup('manual', res.filePath.endsWith('.sbmbak') ? res.filePath : `${res.filePath}.sbmbak`);
  },
  'backup.list': (_p, ctx) => { if (ctx) requirePerm(ctx, 'backup.manage'); return { dir: backupDir(), items: listBackups(backupDir()) }; },
  'backup.openDir': () => { mkdirSync(backupDir(), { recursive: true }); return shell.openPath(backupDir()); },
  'backup.chooseDir': async (_p, ctx) => {
    requirePerm(ctx!, 'backup.manage');
    const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openDirectory', 'createDirectory'] });
    if (res.canceled || !res.filePaths[0]) return { canceled: true };
    setSettingRaw(db!, 'backup.directory', res.filePaths[0]);
    return { dir: res.filePaths[0] };
  },
  'backup.inspect': async (p, ctx) => {
    if (ctx) requirePerm(ctx, 'backup.manage');
    let file: string | undefined = p?.file;
    if (file && !listBackups(backupDir()).some((b) => b.file === file)) file = undefined; // only files we listed
    if (!file) {
      const res = await dialog.showOpenDialog(mainWindow!, { properties: ['openFile'], defaultPath: backupDir(), filters: [{ name: 'نسخة احتياطية', extensions: ['sbmbak'] }] });
      if (res.canceled || !res.filePaths[0]) return { canceled: true };
      file = res.filePaths[0];
    }
    const { info, dbFile } = validateBackup(file, workDir);
    try { unlinkSync(dbFile); } catch { /* ignore */ }
    const token = randomUUID();
    pendingRestores.set(token, file);
    return { token, info };
  },
  'backup.restore': async (p, ctx) => {
    if (ctx) requirePerm(ctx, 'backup.manage');
    const file = pendingRestores.get(String(p?.token ?? ''));
    if (!file) throw new AppError('BACKUP_INVALID');
    pendingRestores.delete(String(p.token));
    const storeName = db ? getSetting(db, 'store.name') : '';
    if (db) {
      const result = await restoreBackup({
        file, dbPath, workDir, db, appVersion: app.getVersion(), storeName,
        close: () => { db!.close(); db = null; },
        reopen: () => { db = openDb(); return db; },
      });
      if (ctx?.user) audit(makeCtx(null), 'backup.restore', 'backup', null, undefined, { file, by: ctx.user.username });
      currentUser = null;
      recoveryMode = false;
      return { ok: true, info: result.info };
    }
    // recovery mode: live DB is unusable; keep the broken file aside and install the backup
    const { dbFile } = validateBackup(file, workDir);
    const broken = `${dbPath}.broken-${Date.now()}`;
    try { if (existsSync(dbPath)) renameSync(dbPath, broken); } catch { /* ignore */ }
    for (const ext of ['-wal', '-shm']) { try { rmSync(dbPath + ext, { force: true }); } catch { /* ignore */ } }
    renameSync(dbFile, dbPath);
    db = openDb();
    recoveryMode = !quickCheck(db);
    currentUser = null;
    return { ok: true };
  },
  'print.sale': async (p, ctx) => {
    const sale = getSale(ctx!, p.id);
    const html = renderReceiptHtml({ sale, settings: getAllSettings(db!), vendorLine: vendorLine(), copyLabel: p.copy ? 'نسخة' : undefined });
    return printOrPdf(html, p.mode ?? 'print', `فاتورة-${sale.invoice_no}.pdf`);
  },
  'print.return': async (p, ctx) => {
    const r = getReturn(ctx!, p.id);
    const s = getAllSettings(db!);
    const money = (v: number) => (v / 100).toFixed(2);
    const rows: [string, string][] = [['رقم المرتجع', r.return_no], ['الفاتورة الأصلية', r.invoice_no], ['التاريخ', r.created_at.replace('T', ' ').slice(0, 16)], ['الموظف', r.user_name],
      ...((r.items as any[]).map((i) => [`${i.product_name}`, money(i.total)] as [string, string])), ['إجمالي المرتجع', money(r.total)], ['طريقة الرد', { cash: 'نقدي', card: 'كارت', wallet: 'محفظة', credit: 'رصيد العميل' }[r.refund_method as string] ?? r.refund_method]];
    return printOrPdf(renderSimpleDoc(s, 'إيصال مرتجع', rows), p.mode ?? 'print', `مرتجع-${r.return_no}.pdf`);
  },
  'print.doc': async (p) => {
    const s = getAllSettings(db!);
    const rows = (Array.isArray(p.rows) ? p.rows : []).slice(0, 200).map((r: unknown[]) => [String(r[0] ?? ''), String(r[1] ?? '')] as [string, string]);
    return printOrPdf(renderSimpleDoc(s, String(p.title ?? '').slice(0, 100), rows), p.mode ?? 'print', `${String(p.title ?? 'document')}.pdf`);
  },
  'print.printers': async () => listPrinters(),
  'print.test': async (_p, ctx) => {
    requirePerm(ctx!, 'settings.manage');
    const s = getAllSettings(db!);
    return printOrPdf(renderSimpleDoc(s, 'صفحة اختبار الطابعة', [['المحل', s['store.name']], ['نوع الورق', s['print.type']], ['الطابعة', s['print.printerName'] || 'الافتراضية'], ['التاريخ', new Date().toLocaleString('ar-EG')]]), 'print', 'test.pdf');
  },
};

ipcMain.handle('api', async (event, channel: unknown, payload: unknown) => {
  if (!senderAllowed(event)) {
    log.warn('rejected IPC from unexpected sender', event.senderFrame?.url);
    return { ok: false, error: { code: 'FORBIDDEN' } };
  }
  const name = String(channel);
  try {
    const sp = special[name];
    const route = routes[name];
    if (!sp && !route) throw new AppError('NOT_FOUND');
    if (recoveryMode && !['app.boot', 'app.info', 'backup.inspect', 'backup.restore', 'backup.list', 'license.status'].includes(name)) throw new AppError('RESTORE_FAILED');
    const isPublic = route?.public || ['app.boot', 'app.info', 'auth.login', 'license.status', 'license.activate'].includes(name) || (recoveryMode && !!sp);
    // reload the session user on every call so role changes / deactivation apply immediately
    if (currentUser && db) currentUser = reloadUser(makeCtx(null), currentUser.id);
    if (!isPublic && !currentUser) throw new AppError('NOT_AUTHENTICATED');
    const exempt = route?.licenseExempt || LICENSE_EXEMPT_EXTRA.has(name);
    if (!exempt && !recoveryMode) {
      const lic = licenseStatus();
      if (!lic.canOperate) throw new AppError(lic.state === 'clock' ? 'CLOCK_TAMPERED' : 'LICENSE_REQUIRED');
    }
    let data = (payload ?? {}) as Record<string, unknown>;
    let approver: SessionUser | null = null;
    if (data && typeof data === 'object' && '__approval' in data) {
      const a = data.__approval as { username?: string; password?: string } | undefined;
      const { __approval: _drop, ...rest } = data;
      data = rest;
      if (a?.username) {
        try { approver = authenticate(makeCtx(null), a.username, a.password ?? ''); } catch { throw new AppError('APPROVAL_INVALID'); }
      }
    }
    const ctx = db ? { ...makeCtx(currentUser), approver } : null;
    if (Array.isArray(payload)) data = payload as never;
    const result = sp ? await sp(data, ctx) : await route!.fn(ctx!, data);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: toErrorPayload(e, name) };
  }
});

/* ------------------------------------------------------------------ window */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1366,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f6f8',
    title: VENDOR.productNameAr,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      spellcheck: false,
      devTools: !app.isPackaged || !!process.env.SBM_DEVTOOLS,
    },
  });
  mainWindow.once('ready-to-show', () => { mainWindow?.maximize(); mainWindow?.show(); });
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (e, url) => {
    const allowed = process.env.SBM_DEV_URL ? url.startsWith(process.env.SBM_DEV_URL) : url.startsWith('file://');
    if (!allowed) e.preventDefault();
  });
  if (process.env.SBM_DEV_URL) mainWindow.loadURL(process.env.SBM_DEV_URL);
  else mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('second-instance', () => {
  if (mainWindow) { if (mainWindow.isMinimized()) mainWindow.restore(); mainWindow.focus(); }
});

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  // strict CSP for the renderer (packaged build); no remote content at all
  session.defaultSession.webRequest.onHeadersReceived((details, cb) => {
    if (process.env.SBM_DEV_URL) return cb({ responseHeaders: details.responseHeaders });
    cb({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; frame-src 'self' data: blob:; object-src 'none'; base-uri 'none'"],
      },
    });
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  initDatabase();
  initLicense();
  createWindow();
  setTimeout(() => void maybeAutoBackup(), 60_000).unref();
  setInterval(() => void maybeAutoBackup(), 60 * 60_000).unref();
  log.info(`app started v${app.getVersion()} (${process.platform}) data=${dataDir}`);
});

app.on('window-all-closed', () => {
  try { db?.pragma('wal_checkpoint(TRUNCATE)'); db?.close(); } catch { /* ignore */ }
  app.quit();
});

