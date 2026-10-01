import { BrowserWindow, app } from 'electron';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PaperType } from './receipt';

const PAPER_WIDTH_MICRONS: Record<PaperType, number> = { thermal80: 80_000, thermal58: 58_000, a4: 210_000 };

async function loadDoc(html: string, paper: PaperType): Promise<{ win: BrowserWindow; heightMicrons: number; cleanup: () => void }> {
  const widthPx = Math.round((PAPER_WIDTH_MICRONS[paper] / 25_400) * 96);
  const win = new BrowserWindow({
    show: false,
    width: widthPx,
    height: 800,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, javascript: true, offscreen: false },
  });
  // documents are generated locally; block any navigation away
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  // a temp file (not a data: URL) avoids Chromium's URL size limits for large documents
  const dir = mkdtempSync(join(app.getPath('temp'), 'sbm-print-'));
  const file = join(dir, 'doc.html');
  writeFileSync(file, html, 'utf8');
  const cleanup = () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } };
  try {
    await win.loadFile(file);
  } catch (e) {
    win.destroy();
    cleanup();
    throw e;
  }
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  const heightPx = (await win.webContents.executeJavaScript('Math.ceil(document.documentElement.scrollHeight)')) as number;
  const heightMicrons = paper === 'a4' ? 297_000 : Math.max(Math.ceil(((heightPx + 24) / 96) * 25_400), 60_000);
  return { win, heightMicrons, cleanup };
}

export async function htmlToPdf(html: string, paper: PaperType): Promise<Buffer> {
  const { win, heightMicrons, cleanup } = await loadDoc(html, paper);
  try {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: paper === 'a4' ? 'A4' : { width: PAPER_WIDTH_MICRONS[paper] / 25_400, height: heightMicrons / 25_400 },
      margins: paper === 'a4' ? { top: 0.4, bottom: 0.4, left: 0.4, right: 0.4 } : { top: 0, bottom: 0, left: 0, right: 0 },
    });
    return Buffer.from(pdf);
  } finally {
    win.destroy();
    cleanup();
  }
}

export async function listPrinters(): Promise<{ name: string; displayName: string; isDefault: boolean }[]> {
  const win = new BrowserWindow({ show: false });
  try {
    const list = await win.webContents.getPrintersAsync();
    return list.map((p) => ({ name: p.name, displayName: p.displayName || p.name, isDefault: !!(p as { isDefault?: boolean }).isDefault }));
  } finally {
    win.destroy();
  }
}

/** Print silently to the configured printer (or the system default). */
export async function printHtml(html: string, opts: { paper: PaperType; printerName?: string; copies?: number; silent?: boolean }): Promise<void> {
  const { win, heightMicrons, cleanup } = await loadDoc(html, opts.paper);
  try {
    await new Promise<void>((resolve, reject) => {
      win.webContents.print(
        {
          silent: opts.silent !== false,
          printBackground: true,
          deviceName: opts.printerName || undefined,
          copies: Math.max(1, Math.min(opts.copies ?? 1, 5)),
          margins: { marginType: 'none' },
          pageSize: opts.paper === 'a4' ? 'A4' : { width: PAPER_WIDTH_MICRONS[opts.paper], height: heightMicrons },
        },
        (success, reason) => (success ? resolve() : reject(new Error(`print failed: ${reason}`))),
      );
    });
  } finally {
    win.destroy();
    cleanup();
  }
}
