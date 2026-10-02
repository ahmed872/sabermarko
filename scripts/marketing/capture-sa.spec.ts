import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { go, launch } from '../../tests/e2e/helpers';

// A Saudi grocery (تموينات) set up the way a customer there would: riyal, 15% VAT, piece + carton products.
const OUT = join(__dirname, '../../docs/marketing/sa/shots');
mkdirSync(OUT, { recursive: true });
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

async function size(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1440, 900); w.center(); });
}
async function snap(page: Page, name: string, opts: { modal?: boolean } = {}) {
  await page.waitForTimeout(450);
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  await (opts.modal ? page.locator('.modal').last() : page).screenshot({ path: join(OUT, `${name}.png`) });
}
async function product(page: Page, p: { name: string; cat: string; unit: string; pack?: [string, string]; price: string; cost: string; packs?: string; qty?: string; barcode?: string; weight?: boolean; expiry?: boolean }) {
  await go(page, '/products/new');
  await page.locator('#pname').fill(p.name);
  await page.locator('#p-category').selectOption({ label: p.cat });
  if (p.weight) await page.getByRole('button', { name: /بالوزن \(كيلو\)/ }).click();
  else await page.locator('#p-base-unit').selectOption({ label: p.unit });
  if (p.pack) {
    await page.locator('#p-selling .switch').click();
    await page.locator('#p-pack-unit').selectOption({ label: p.pack[0] });
    await page.locator('#p-pack-count').fill(p.pack[1]);
  }
  await page.locator('#p-price').fill(p.price);
  await page.locator('#p-cost').fill(p.cost);
  if (p.barcode) await page.locator('#p-barcode').fill(p.barcode);
  if (p.packs) await page.locator('#p-opening-packs').fill(p.packs);
  if (p.qty) await page.locator('#p-opening').fill(p.qty);
  if (p.expiry) await page.locator('.field', { hasText: 'له تاريخ صلاحية؟' }).locator('.switch').click();
  await page.locator('.switch').first().click(); // quick product on the POS
  return async () => {
    await page.getByRole('button', { name: 'حفظ', exact: true }).click();
    await expect(page.locator('.page-header h1')).toContainText(p.name.split(' ')[0]);
  };
}

test('marketing: Saudi grocery', async () => {
  const { app, page } = await launch();
  await size(app);
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.getByPlaceholder('مثال: سوبر ماركت البركة').fill('تموينات الريان');
  await page.locator('input[dir="ltr"]').first().fill('0551234567');
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.locator('.auth-card select').first().selectOption({ label: 'ريال سعودي (ر.س)' });
  await page.locator('.auth-card input[type=radio]').nth(1).check(); // advanced: expiry & batches
  await page.getByRole('button', { name: /التالي/ }).click();
  const inputs = page.locator('.auth-card input');
  await inputs.nth(0).fill('أبو فهد');
  await inputs.nth(1).fill('admin');
  await inputs.nth(2).fill('1234');
  await inputs.nth(3).fill('1234');
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.getByRole('button', { name: 'ابدأ استخدام البرنامج' }).click();
  await expect(page.getByText(/(صباح|مساء) الخير/)).toBeVisible();
  await page.evaluate(() => (window as any).sbm.invoke('settings.update', { 'features.tax': true, 'tax.rate': 15, 'tax.inclusive': true, 'store.address': 'الرياض — حي النرجس', 'store.taxNumber': '300000000000003' }));
  await page.reload();
  await expect(page.getByText(/(صباح|مساء) الخير/)).toBeVisible();

  let save = await product(page, { name: 'مشروب غازي كانز 330 مل', cat: 'مشروبات', unit: 'حبة', pack: ['كرتون', '30'], price: '3', cost: '57', packs: '12', qty: '8', barcode: '6281000000011' });
  await page.locator('#p-selling').scrollIntoViewIfNeeded();
  await snap(page, 'product-pack');
  await save();
  await (await product(page, { name: 'مياه شرب 330 مل', cat: 'مشروبات', unit: 'حبة', pack: ['كرتون', '40'], price: '1', cost: '24', packs: '20' }))();
  await (await product(page, { name: 'حليب طازج 1 لتر', cat: 'ألبان وأجبان', unit: 'علبة', pack: ['كرتون', '12'], price: '7', cost: '66', expiry: true }))();
  await (await product(page, { name: 'تمر سكري فاخر', cat: 'منتجات بالوزن', unit: '', weight: true, price: '45', cost: '32', qty: '25' }))();
  await (await product(page, { name: 'رز بسمتي 5 كيلو', cat: 'بقالة جافة', unit: 'كيس', price: '55', cost: '44', qty: '30' }))();
  await (await product(page, { name: 'شيبس ملح 23 جم', cat: 'شيبسي وسناكس', unit: 'حبة', pack: ['كرتون', '24'], price: '1', cost: '17', packs: '6' }))();
  await (await product(page, { name: 'قهوة عربية بالهيل 250 جم', cat: 'بقالة جافة', unit: 'علبة', price: '28', cost: '20', qty: '18' }))();

  // milk delivered with an expiry in 6 days -> the expiry screen and the dashboard warn
  await go(page, '/purchases/new');
  const picker = page.getByPlaceholder(/ابحث عن منتج بالاسم أو الباركود/);
  await picker.fill('حليب');
  await picker.press('Enter');
  await page.waitForTimeout(500);
  await page.locator('tbody tr').first().locator('input.num-input').first().fill('4');
  const d = new Date(); d.setDate(d.getDate() + 6);
  await page.getByLabel('تاريخ الصلاحية').fill(iso(d));
  await page.getByRole('button', { name: 'الكل', exact: true }).click();
  await page.getByRole('button', { name: 'حفظ فاتورة الشراء' }).click();
  await expect(page.getByText(/تم حفظ فاتورة الشراء/)).toBeVisible();
  await page.waitForTimeout(600);
  await page.keyboard.press('Escape');

  // POS
  await go(page, '/pos');
  await page.locator('input.num-input').first().fill('300');
  await page.getByRole('button', { name: 'فتح الوردية وبدء البيع' }).click();
  const search = page.getByPlaceholder(/ابحث باسم المنتج/);
  for (const code of ['6281000000011', '6281000000011', '6281000000011']) { await search.fill(code); await search.press('Enter'); }
  await page.locator('.tile', { hasText: 'شيبس' }).click();
  await page.locator('.tile', { hasText: 'شيبس' }).click();
  await page.locator('.tile', { hasText: 'رز بسمتي' }).click();
  await page.locator('.tile', { hasText: 'قهوة عربية' }).click();
  await page.locator('.tile', { hasText: 'تمر سكري' }).click();
  await page.locator('.modal input.num-input').fill('500');
  await snap(page, 'weight', { modal: true });
  await page.getByRole('button', { name: /إضافة/ }).click();
  await expect(page.locator('.cart-line')).toHaveCount(5);
  await snap(page, 'pos');
  await page.keyboard.press('F9');
  await page.locator('.modal input.num-input').fill('200');
  await snap(page, 'payment', { modal: true });
  await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
  await expect(page.getByText(/تم حفظ الفاتورة رقم/)).toBeVisible();
  await page.waitForTimeout(600);
  await snap(page, 'receipt');
  await page.keyboard.press('Enter');
  // a few more sales for the dashboard
  for (const [q, n] of [['مياه', 6], ['حليب', 2], ['قهوة', 1], ['مشروب', 4]] as const) {
    for (let i = 0; i < n; i++) await page.locator('.tile', { hasText: q }).click();
    await page.keyboard.press('F9');
    await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
    await expect(page.getByText(/تم حفظ الفاتورة رقم/)).toBeVisible();
    await page.keyboard.press('Enter');
    await page.waitForTimeout(300);
  }

  await go(page, '/');
  await page.waitForTimeout(1200);
  await snap(page, 'dashboard');
  await go(page, '/inventory/expiry');
  await page.waitForTimeout(800);
  await snap(page, 'expiry');
  await go(page, '/products');
  await page.waitForTimeout(800);
  await snap(page, 'products');
  await go(page, '/stocktake');
  await page.getByRole('button', { name: /بدء جرد جديد/ }).click();
  await page.getByRole('button', { name: 'بدء الجرد' }).click();
  const row = page.locator('tr', { hasText: 'مشروب غازي' });
  await row.getByLabel('كرتون').fill('12');
  await row.getByLabel('حبة').fill('1');
  await row.getByLabel('حبة').press('Enter');
  await page.waitForTimeout(700);
  await snap(page, 'stocktake');
  await go(page, '/day-close');
  await page.waitForTimeout(900);
  await snap(page, 'day-close');
  await go(page, '/reports');
  await page.waitForTimeout(1200);
  await snap(page, 'reports');
  await app.close();
});
