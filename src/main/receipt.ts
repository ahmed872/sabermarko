import { formatMoney, type CurrencyConfig } from '../shared/money';
import { formatQty } from '../shared/qty';
import { initials } from '../shared/arabic';
import type { StoreSettings } from '../shared/settings';
import { EMBEDDED_FONT_CSS } from './fonts';

const METHOD_LABELS: Record<string, string> = { cash: 'نقدي', card: 'كارت', wallet: 'محفظة', credit: 'آجل', bank: 'تحويل بنكي' };

function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function fmtDate(iso: string, digits: 'latn' | 'arab'): string {
  const [d, t] = String(iso).split('T');
  const [y, m, day] = d.split('-');
  const s = `${day}/${m}/${y} ${(t ?? '').slice(0, 5)}`;
  return digits === 'arab' ? s.replace(/\d/g, (x) => '٠١٢٣٤٥٦٧٨٩'[Number(x)]) : s;
}

export type PaperType = StoreSettings['print.type'];

function pageCss(paper: PaperType): string {
  const width = paper === 'thermal58' ? '58mm' : paper === 'thermal80' ? '80mm' : '210mm';
  const contentWidth = paper === 'thermal58' ? '50mm' : paper === 'thermal80' ? '72mm' : '186mm';
  const base = paper === 'a4' ? 12 : paper === 'thermal58' ? 10 : 11.5;
  return `${EMBEDDED_FONT_CSS}
  @page { size: ${paper === 'a4' ? 'A4' : `${width} auto`}; margin: ${paper === 'a4' ? '12mm' : '2mm 0'}; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  body { font-family: 'IBM Plex Sans Arabic', 'Segoe UI', Tahoma, Arial, sans-serif; font-size: ${base}px; line-height: 1.45; direction: rtl; }
  .r { width: ${contentWidth}; margin: 0 auto; }
  .center { text-align: center; }
  .logo { max-width: ${paper === 'a4' ? '120px' : '46mm'}; max-height: 70px; display: block; margin: 0 auto 4px; }
  .avatar { width: 48px; height: 48px; border-radius: 50%; border: 2px solid #000; display: flex; align-items: center; justify-content: center; margin: 0 auto 4px; font-weight: 700; font-size: 18px; }
  .store { font-size: ${base + 5}px; font-weight: 700; }
  .muted { font-size: ${base - 1}px; }
  .sep { border-top: 1px dashed #000; margin: 6px 0; }
  .meta { display: flex; justify-content: space-between; gap: 6px; flex-wrap: wrap; }
  table { width: 100%; border-collapse: collapse; }
  th { font-weight: 700; border-bottom: 1px solid #000; padding: 2px 0; text-align: right; font-size: ${base - 0.5}px; }
  td { padding: 2px 0; vertical-align: top; }
  td.n, th.n { text-align: left; white-space: nowrap; direction: ltr; }
  .item-name { font-weight: 600; }
  .sub { font-size: ${base - 1.5}px; }
  .tot td { padding: 1px 0; }
  .grand td { font-size: ${base + 4}px; font-weight: 700; border-top: 1px solid #000; padding-top: 4px; }
  .badge { display: inline-block; border: 1.5px solid #000; padding: 1px 8px; font-weight: 700; margin: 4px 0; }
  .footer { margin-top: 8px; }
  ${paper === 'a4' ? 'table.items td, table.items th { border-bottom: 1px solid #ccc; padding: 5px 4px; } .store { font-size: 22px; } .head { display:flex; justify-content: space-between; align-items: center; } .head .center{ text-align: right; }' : ''}
  `;
}

export interface ReceiptData {
  sale: any; // getSale() result
  settings: StoreSettings;
  vendorLine?: string;
  copyLabel?: string;
}

export function renderReceiptHtml({ sale, settings, vendorLine, copyLabel }: ReceiptData): string {
  const paper = settings['print.type'];
  const cur: CurrencyConfig = { code: settings['currency.code'], symbol: settings['currency.symbol'], digits: settings['ui.digits'] };
  const m = (v: number) => formatMoney(v, cur, { withSymbol: false });
  const q = (v: number) => formatQty(v, cur.digits);
  const logo = settings['print.showLogo'] && settings['store.logo']
    ? `<img class="logo" src="${esc(settings['store.logo'])}" alt="">`
    : settings['print.showLogo'] ? `<div class="avatar">${esc(initials(settings['store.name'] || 'م'))}</div>` : '';
  // weighed sub-units (e.g. grams of a per-kg product) show the per-kg price: "250 جم × 180 / كجم"
  const qtyLine = (it: any) => it.factor < 1000
    ? `${q(it.qty)} ${esc(it.unit_symbol ?? it.unit_name)} × ${m(Math.round((it.unit_price * 1000) / it.factor))} / ${esc(it.base_unit_symbol ?? '')}`
    : `${q(it.qty)} ${esc(it.unit_symbol ?? it.unit_name)} × ${m(it.unit_price)}`;
  const items = (sale.items as any[]).map((it) => {
    const disc = it.discount + it.promo_discount;
    return `<tr>
      <td><div class="item-name">${esc(it.product_name)}</div>
        <div class="sub">${qtyLine(it)}${disc > 0 ? ` — خصم ${m(disc)}` : ''}</div></td>
      <td class="n">${m(it.gross - disc)}</td></tr>`;
  }).join('');
  const a4Rows = (sale.items as any[]).map((it, i) => {
    const disc = it.discount + it.promo_discount;
    const sub = it.factor < 1000;
    return `<tr><td>${i + 1}</td><td class="item-name">${esc(it.product_name)}</td><td class="n">${q(it.qty)}</td><td>${esc(it.unit_symbol ?? it.unit_name)}</td>
      <td class="n">${sub ? `${m(Math.round((it.unit_price * 1000) / it.factor))} / ${esc(it.base_unit_symbol ?? '')}` : m(it.unit_price)}</td>
      <td class="n">${disc > 0 ? m(disc) : '—'}</td><td class="n"><b>${m(it.gross - disc)}</b></td></tr>`;
  }).join('');
  const a4Table = `<table class="items"><thead><tr><th>#</th><th>الصنف</th><th class="n">الكمية</th><th>الوحدة</th><th class="n">السعر</th><th class="n">الخصم</th><th class="n">الإجمالي</th></tr></thead><tbody>${a4Rows}</tbody></table>`;
  const discountTotal = sale.line_discount + sale.invoice_discount;
  const payments = (sale.payments as any[]).map((p) => `<tr><td>${METHOD_LABELS[p.method] ?? p.method}</td><td class="n">${m(p.amount)}</td></tr>`).join('');
  const tendered = sale.paid;
  const header = `
    <div class="head">
      <div class="center">
        ${logo}
        <div class="store">${esc(settings['store.name'])}</div>
        ${settings['store.address'] ? `<div class="muted">${esc(settings['store.address'])}</div>` : ''}
        ${settings['store.phone'] ? `<div class="muted">هاتف: <span dir="ltr">${esc(settings['store.phone'])}</span></div>` : ''}
        ${settings['store.taxNumber'] ? `<div class="muted">رقم ضريبي: ${esc(settings['store.taxNumber'])}</div>` : ''}
      </div>
      ${paper === 'a4' ? `<div><div class="badge">فاتورة بيع</div></div>` : ''}
    </div>`;
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>فاتورة ${esc(sale.invoice_no)}</title>
  <style>${pageCss(paper)}</style></head><body><div class="r">
  ${header}
  <div class="sep"></div>
  ${paper !== 'a4' ? '<div class="center"><span class="badge">فاتورة بيع</span></div>' : ''}
  ${sale.status === 'voided' ? '<div class="center"><span class="badge">ملغاة</span></div>' : ''}
  ${copyLabel ? `<div class="center muted">${esc(copyLabel)}</div>` : ''}
  <div class="meta"><span>رقم: <b dir="ltr">${esc(sale.invoice_no)}</b></span><span dir="ltr">${fmtDate(sale.created_at, cur.digits)}</span></div>
  <div class="meta"><span>الكاشير: ${esc(sale.cashier_name)}</span>${sale.customer_name ? `<span>العميل: ${esc(sale.customer_name)}</span>` : ''}</div>
  <div class="sep"></div>
  ${paper === 'a4' ? a4Table : `<table class="items"><thead><tr><th>الصنف</th><th class="n">الإجمالي</th></tr></thead><tbody>${items}</tbody></table>`}
  <div class="sep"></div>
  <table class="tot">
    <tr><td>عدد الأصناف</td><td class="n">${sale.items.length}</td></tr>
    <tr><td>الإجمالي قبل الخصم</td><td class="n">${m(sale.subtotal)}</td></tr>
    ${discountTotal > 0 ? `<tr><td>الخصم</td><td class="n">- ${m(discountTotal)}</td></tr>` : ''}
    ${sale.tax_total > 0 ? `<tr><td>الضريبة${settings['tax.inclusive'] ? ' (شاملة)' : ''}</td><td class="n">${m(sale.tax_total)}</td></tr>` : ''}
    ${sale.rounding ? `<tr><td>تقريب</td><td class="n">${m(sale.rounding)}</td></tr>` : ''}
    <tr class="grand"><td>الإجمالي</td><td class="n">${m(sale.total)} ${esc(cur.symbol)}</td></tr>
  </table>
  <div class="sep"></div>
  <table class="tot">
    ${payments}
    ${tendered > 0 && sale.change_due > 0 ? `<tr><td>المدفوع</td><td class="n">${m(tendered)}</td></tr><tr><td><b>الباقي للعميل</b></td><td class="n"><b>${m(sale.change_due)}</b></td></tr>` : ''}
    ${sale.credit_amount > 0 ? `<tr><td>رصيد العميل الحالي</td><td class="n">${m(sale.customer_balance ?? 0)}</td></tr>` : ''}
  </table>
  <div class="sep"></div>
  <div class="center footer">
    ${settings['store.receiptFooter'] ? `<div>${esc(settings['store.receiptFooter'])}</div>` : ''}
    ${vendorLine ? `<div class="muted" style="margin-top:4px">${esc(vendorLine)}</div>` : ''}
  </div>
  </div></body></html>`;
}

/** Generic simple document (shift report, payment receipt, return receipt). */
export function renderSimpleDoc(settings: StoreSettings, title: string, rows: [string, string][], extraHtml = ''): string {
  const paper = settings['print.type'];
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(title)}</title><style>${pageCss(paper)}</style></head>
  <body><div class="r"><div class="center"><div class="store">${esc(settings['store.name'])}</div>
  ${settings['store.phone'] ? `<div class="muted" dir="ltr">${esc(settings['store.phone'])}</div>` : ''}</div>
  <div class="sep"></div><div class="center"><span class="badge">${esc(title)}</span></div>
  <table class="tot">${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="n">${esc(v)}</td></tr>`).join('')}</table>
  ${extraHtml}<div class="sep"></div></div></body></html>`;
}
