import { test, expect, type Page, type ElectronApplication } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { go, launch } from '../../tests/e2e/helpers';

// Walks the real app as a first-time owner would and photographs every step for the user guide.
const OUT = join(__dirname, '../../docs/user-guide/img');
mkdirSync(OUT, { recursive: true });

async function size(app: ElectronApplication) {
  await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; w.setContentSize(1366, 800); w.center(); });
}
async function snap(page: Page, name: string, opts: { modal?: boolean; height?: number; card?: boolean } = {}) {
  await page.waitForTimeout(450);
  // let toasts fade so they do not cover the screen
  await page.locator('.toast').first().waitFor({ state: 'detached', timeout: 6000 }).catch(() => {});
  if (opts.height) { await page.screenshot({ path: join(OUT, `${name}.png`), clip: { x: 0, y: 0, width: page.viewportSize()?.width ?? 1280, height: opts.height } }); return; }
  const target = opts.card ? page.locator('.auth-card').first() : opts.modal ? page.locator('.modal').last() : page;
  await target.screenshot({ path: join(OUT, `${name}.png`) });
}

test('guide: a new store from the first screen to closing the day', async () => {
  const { app, page } = await launch();
  await size(app);
  await expect(page.getByRole('button', { name: /التالي/ })).toBeVisible();
  await snap(page, '01-welcome', { card: true });
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.getByPlaceholder('مثال: سوبر ماركت البركة').fill('سوبر ماركت البركة');
  await page.locator('input[dir="ltr"]').first().fill('01012345678');
  await snap(page, '02-store', { card: true });
  await page.getByRole('button', { name: /التالي/ }).click();
  await snap(page, '03-settings', { card: true });
  await page.getByRole('button', { name: /التالي/ }).click();
  const inputs = page.locator('.auth-card input');
  await inputs.nth(0).fill('أحمد صابر');
  await inputs.nth(1).fill('admin');
  await inputs.nth(2).fill('1234');
  await inputs.nth(3).fill('1234');
  await snap(page, '04-admin', { card: true });
  await page.getByRole('button', { name: /التالي/ }).click();
  await snap(page, '05-done', { card: true });
  await page.getByRole('button', { name: 'ابدأ استخدام البرنامج' }).click();
  await expect(page.getByText(/(صباح|مساء) الخير/)).toBeVisible();
  await snap(page, '06-dashboard-empty');

  await go(page, '/license');
  await page.waitForTimeout(600);
  await snap(page, '07-license');

  // ---- products
  await go(page, '/products/new');
  await page.locator('#pname').fill('بيبسي كانز 330 مل');
  await page.locator('#p-category').selectOption({ label: 'مشروبات' });
  await page.locator('#p-base-unit').selectOption({ label: 'كانز' });
  await page.locator('#p-selling .switch').click();
  await page.locator('#p-pack-unit').selectOption({ label: 'دستة' });
  await page.locator('#p-pack-count').fill('12');
  await page.locator('#p-price').fill('30');
  await page.locator('#p-cost').fill('300');
  await page.locator('#p-barcode').fill('6223001234567');
  await page.locator('#p-opening-packs').fill('10');
  await page.locator('#p-opening').fill('5');
  await page.locator('.switch').first().click();
  await page.locator('#p-selling').scrollIntoViewIfNeeded();
  await snap(page, '10-product-pack');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.locator('.page-header h1')).toContainText('بيبسي');
  await snap(page, '11-product-detail');

  await go(page, '/products/new');
  await page.locator('#pname').fill('جبنة رومي');
  await page.getByRole('button', { name: /بالوزن \(كيلو\)/ }).click();
  await page.locator('#p-price').fill('180');
  await page.locator('#p-cost').fill('140');
  await page.locator('#p-opening').fill('8');
  await page.locator('.switch').first().click();
  await page.locator('#p-selling').scrollIntoViewIfNeeded();
  await snap(page, '12-product-weight');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.locator('.page-header h1')).toContainText('جبنة');

  await go(page, '/products/new');
  await page.locator('#pname').fill('شيبسي طماطم كبير');
  await page.locator('#p-base-unit').selectOption({ label: 'كيس' });
  await page.locator('#p-selling .switch').click();
  await page.locator('#p-pack-unit').selectOption({ label: 'كرتونة' });
  await page.locator('#p-pack-count').fill('24');
  await page.locator('#p-price').fill('10');
  await page.locator('#p-cost').fill('192');
  await page.locator('#p-opening-packs').fill('3');
  await page.locator('.switch').first().click();
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.locator('.page-header h1')).toContainText('شيبسي');
  await go(page, '/products');
  await page.waitForTimeout(600);
  await snap(page, '13-products');

  // ---- supplier + purchase
  await go(page, '/suppliers');
  await page.getByRole('button', { name: /مورد جديد/ }).click();
  await page.locator('.modal input').nth(0).fill('شركة بيبسيكو');
  await page.locator('.modal input').nth(1).fill('01000000001');
  await snap(page, '20-supplier', { modal: true });
  await page.locator('.modal-foot .btn.primary').click();
  await go(page, '/purchases/new');
  await page.locator('select', { has: page.locator('option', { hasText: 'بدون مورد' }) }).selectOption({ label: 'شركة بيبسيكو' });
  const picker = page.getByPlaceholder(/ابحث عن منتج بالاسم أو الباركود/);
  await picker.fill('بيبسي');
  await picker.press('Enter');
  await page.waitForTimeout(500);
  await page.locator('tbody tr').first().locator('input.num-input').first().fill('5');
  await page.waitForTimeout(400);
  await snap(page, '21-purchase');
  await page.getByRole('button', { name: 'حفظ فاتورة الشراء' }).click();
  await expect(page.getByText(/تم حفظ فاتورة الشراء/)).toBeVisible();
  await page.waitForTimeout(800);
  await snap(page, '22-purchase-saved');
  await page.keyboard.press('Escape');

  // ---- POS
  await go(page, '/pos');
  await expect(page.getByRole('heading', { name: 'فتح الوردية' })).toBeVisible();
  await page.locator('input.num-input').first().fill('500');
  await snap(page, '30-open-shift');
  await page.getByRole('button', { name: 'فتح الوردية وبدء البيع' }).click();
  const search = page.getByPlaceholder(/ابحث باسم المنتج/);
  await search.fill('6223001234567');
  await search.press('Enter');
  await page.locator('.tile', { hasText: 'بيبسي' }).click();
  await page.locator('.tile', { hasText: 'شيبسي' }).click();
  await page.locator('.tile', { hasText: 'جبنة رومي' }).click();
  await expect(page.getByText(/جبنة رومي — /)).toBeVisible();
  await page.locator('.modal input.num-input').fill('250');
  await snap(page, '31-weight', { modal: true });
  await page.getByRole('button', { name: /إضافة/ }).click();
  await expect(page.locator('.cart-line')).toHaveCount(3);
  await snap(page, '32-pos-cart');
  await page.keyboard.press('F9');
  await expect(page.getByText('المبلغ المستلم من العميل')).toBeVisible();
  await page.locator('.modal input.num-input').fill('200');
  await snap(page, '33-payment', { modal: true });
  await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
  await expect(page.getByText(/تم حفظ الفاتورة رقم/)).toBeVisible();
  await page.waitForTimeout(500);
  await snap(page, '34-receipt');
  await page.keyboard.press('Enter');

  // ---- invoices + return
  await go(page, '/sales');
  await page.waitForTimeout(500);
  await page.locator('tbody tr').first().click();
  await expect(page.locator('.modal')).toBeVisible();
  await snap(page, '40-invoice', { modal: true });
  await page.locator('.modal-foot').getByRole('button', { name: 'مرتجع', exact: true }).click();
  await page.waitForTimeout(400);
  await snap(page, '41-return', { modal: true });
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // ---- stocktake
  await go(page, '/stocktake');
  await page.getByRole('button', { name: /بدء جرد جديد/ }).click();
  await page.getByRole('button', { name: 'بدء الجرد' }).click();
  const row = page.locator('tr', { hasText: 'بيبسي' });
  await row.getByLabel('دستة').fill('14');
  await row.getByLabel('كانز').fill('2');
  await row.getByLabel('كانز').press('Enter');
  await page.waitForTimeout(600);
  await snap(page, '50-stocktake');
  await page.getByRole('button', { name: 'إلغاء الجرد' }).click();
  await page.locator('.modal .btn.danger, .modal .btn.primary').last().click();

  // ---- users, backup, settings, shift, day close
  await go(page, '/users');
  await page.getByRole('button', { name: /مستخدم جديد/ }).click();
  await page.locator('.modal input').nth(0).fill('منى');
  await page.locator('.modal input').nth(1).fill('mona');
  await page.locator('.modal input').nth(2).fill('5678');
  await snap(page, '60-user', { modal: true });
  await page.getByRole('button', { name: 'حفظ' }).click();
  await page.waitForTimeout(500);
  await snap(page, '61-users');
  await go(page, '/backup');
  await page.waitForTimeout(600);
  await snap(page, '62-backup', { height: 470 });
  await go(page, '/settings');
  await page.waitForTimeout(600);
  await snap(page, '63-settings');
  await go(page, '/shifts');
  await page.waitForTimeout(600);
  await snap(page, '70-shifts');
  await go(page, '/day-close');
  await page.waitForTimeout(800);
  await snap(page, '71-day-close');
  await app.close();
});

test('guide: a store after a few months (demo data)', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sbm-guide-'));
  execFileSync(process.execPath, [join(__dirname, '../../dist/tools/seed-demo.js'), userData]);
  const { app, page } = await launch({ userData });
  await size(app);
  await snap(page, '80-login');
  await page.getByRole('button', { name: 'الحاج محمود' }).click();
  await page.locator('input[type=password]').fill('1234');
  await page.getByRole('button', { name: /دخول/ }).click();
  await expect(page.getByText(/⚠️ يوجد/).first()).toBeVisible();
  await page.waitForTimeout(800);
  await snap(page, '81-dashboard');
  await go(page, '/inventory/expiry');
  await page.waitForTimeout(800);
  await snap(page, '82-expiry');
  await go(page, '/insights');
  await page.waitForTimeout(1500);
  await snap(page, '83-insights');
  await go(page, '/reports');
  await page.waitForTimeout(1200);
  await snap(page, '84-reports');
  await go(page, '/inventory');
  await page.waitForTimeout(800);
  await snap(page, '85-inventory');
  await app.close();
});
