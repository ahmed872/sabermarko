/**
 * Generates real invoice PDFs from the engine (spec §5 basket) using the
 * same receipt template and print pipeline the app uses.
 * Usage: BUILD_SAMPLE=1 node scripts/build-main.mjs && electron dist/sample/sample-invoice.js <outDir>
 */
import { app } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupStore, addProduct, egp } from '../tests/unit/helpers';
import { checkout, getSale } from '../src/main/services/sales';
import { getAllSettings, setSettingRaw } from '../src/main/services/context';
import { renderReceiptHtml } from '../src/main/receipt';
import { htmlToPdf } from '../src/main/printing';
import { VENDOR } from '../src/shared/brand';

app.disableHardwareAcceleration();
app.on('window-all-closed', () => { /* keep running between print jobs */ });
app.whenReady().then(async () => {
  const out = process.argv[process.argv.length - 1];
  mkdirSync(out, { recursive: true });
  const env = setupStore();
  const piece = env.unit('قطعة');
  const gram = env.unit('جرام');
  const p = (name: string, price: number, extra: Partial<Parameters<typeof addProduct>[1]> = {}) => addProduct(env, { name, price, cost: price * 0.75, qty: 20, ...extra });
  const w = { unit: 'كيلو', weighted: true, units: [{ unit: 'جرام', factor: 0.001 }] };
  const lines = [
    [p('شيبسي طماطم', 10), piece, 1000], [p('شيبسي جبنة كبير', 15), piece, 1000],
    [p('آيس كريم فانيليا', 20), piece, 1000], [p('آيس كريم شوكولاتة', 25), piece, 1000],
    [p('كوكاكولا 330 مل', 15), piece, 1000], [p('بيبسي 330 مل', 15), piece, 1000],
    [p('تونة دولفين 185 جم', 45), piece, 1000],
    [p('جبنة رومي', 180, w), gram, 250_000], [p('لانشون', 160, w), gram, 150_000],
  ].map(([productId, unitId, qty]) => ({ productId, unitId, qty }));
  const sale = checkout(env.ctx, { cart: { lines }, payments: [{ method: 'cash', amount: egp(300) }] });
  for (const paper of ['thermal80', 'a4'] as const) {
    setSettingRaw(env.ctx.db, 'print.type', paper);
    const html = renderReceiptHtml({ sale: getSale(env.ctx, sale.id), settings: getAllSettings(env.ctx.db), vendorLine: `برنامج ${VENDOR.productNameAr}` });
    writeFileSync(join(out, `invoice-${paper}.pdf`), await htmlToPdf(html, paper));
    writeFileSync(join(out, `invoice-${paper}.html`), html);
  }
  console.log('OK', sale.invoice_no, sale.total);
  app.quit();
});
