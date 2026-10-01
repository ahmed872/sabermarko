import { _electron as electron, expect, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch(opts: { userData?: string; executablePath?: string; args?: string[]; env?: Record<string, string> } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'sbm-e2e-'));
  const app = await electron.launch({
    executablePath: opts.executablePath,
    args: opts.executablePath ? (opts.args ?? ['--no-sandbox']) : [join(__dirname, '../..'), '--no-sandbox'],
    env: { ...process.env, SBM_USER_DATA: userData, SBM_LOG_STDOUT: '', ...(opts.executablePath ? {} : { SBM_LICENSE_MIRROR_DIR: userData }), ...opts.env },
  });
  const page = await app.firstWindow();
  await page.waitForLoadState('domcontentloaded');
  return { app, page, userData };
}

export async function shot(page: Page, name: string) {
  await page.screenshot({ path: join(__dirname, '../../test-results/screens', `${name}.png`) });
}

/** In-app navigation (hash router) without reloading the window. */
export async function go(page: Page, path: string) {
  await page.evaluate((p) => { window.location.hash = `#${p}`; }, path);
  await page.waitForTimeout(150);
}

export async function setup(page: Page) {
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.getByPlaceholder('مثال: سوبر ماركت البركة').fill('سوبر ماركت البركة');
  await page.locator('input[dir="ltr"]').first().fill('01012345678');
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.getByRole('button', { name: /التالي/ }).click();
  const inputs = page.locator('.auth-card input');
  await inputs.nth(0).fill('أحمد المدير');
  await inputs.nth(1).fill('admin');
  await inputs.nth(2).fill('1234');
  await inputs.nth(3).fill('1234');
  await page.getByRole('button', { name: /التالي/ }).click();
  await page.getByRole('button', { name: 'ابدأ استخدام البرنامج' }).click();
  await expect(page.getByText(/(صباح|مساء) الخير، أحمد المدير/)).toBeVisible();
}

export async function addProduct(page: Page, p: { name: string; price: string; cost: string; qty: string; unit?: string; barcode?: string; fav?: boolean; pack?: { unit: string; count: string; packs?: string } }) {
  await go(page, '/products/new');
  await page.locator('#pname').fill(p.name);
  if (p.unit === 'كيلو') await page.getByRole('button', { name: /بالوزن \(كيلو\)/ }).click();
  else if (p.unit) await page.locator('#p-base-unit').selectOption({ label: p.unit });
  if (p.pack) {
    await page.locator('#p-selling .switch').click();
    await page.locator('#p-pack-unit').selectOption({ label: p.pack.unit });
    await page.locator('#p-pack-count').fill(p.pack.count);
    if (p.pack.packs) await page.locator('#p-opening-packs').fill(p.pack.packs);
  }
  await page.locator('#p-price').fill(p.price);
  await page.locator('#p-cost').fill(p.cost);
  if (p.barcode) await page.locator('#p-barcode').fill(p.barcode);
  await page.locator('#p-opening').fill(p.qty);
  if (p.fav) await page.locator('.switch').first().click();
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.locator('.page-header h1')).toContainText(p.name);
}

export async function loginAs(page: Page, fullName: string, password: string) {
  // with several users the login screen shows name buttons (loaded asynchronously); with one user it is pre-filled
  const pick = page.locator('.user-pick button', { hasText: fullName });
  await pick.waitFor({ timeout: 3000 }).then(() => pick.click()).catch(() => {});
  await page.locator('input[type=password]').fill(password);
  await page.getByRole('button', { name: /دخول/ }).click();
}

export async function sellOne(page: Page, search: string, paid: string) {
  await go(page, '/pos');
  const open = page.getByRole('button', { name: 'فتح الوردية وبدء البيع' });
  const box0 = page.getByPlaceholder(/ابحث باسم المنتج/);
  await expect(open.or(box0)).toBeVisible();
  if (await open.isVisible().catch(() => false)) {
    await page.locator('input.num-input').first().fill('0');
    await open.click();
  }
  const box = page.getByPlaceholder(/ابحث باسم المنتج/);
  await box.fill(search);
  await box.press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(1);
  const payBox = page.locator('.modal input.num-input');
  // under heavy parallel load the first F9 can land before the POS keyboard handler is bound
  await expect(async () => {
    if (!(await payBox.isVisible())) await page.keyboard.press('F9');
    await expect(payBox).toBeVisible({ timeout: 1500 });
  }).toPass({ timeout: 15_000 });
  await payBox.fill(paid);
  await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
  await expect(page.getByText(/تم حفظ الفاتورة رقم/)).toBeVisible();
  await page.keyboard.press('Enter');
}
