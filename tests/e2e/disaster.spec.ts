import { test, expect } from '@playwright/test';
import { generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addProduct, go, launch, loginAs, sellOne, setup } from './helpers';

/**
 * The shop's computer dies. The owner installs the program on a NEW computer and
 * restores the backup they kept on a flash drive — from the very first screen,
 * without creating a dummy store first. Native file dialogs are stubbed in the
 * main process so the flow is exercised end to end through the real UI.
 */
test('disaster recovery: back up to a flash drive, restore on a brand-new computer from the first screen', async () => {
  const usb = mkdtempSync(join(tmpdir(), 'sbm-usb-'));
  const flashFile = join(usb, 'البركة.sbmbak');

  const oldPc = await launch();
  await setup(oldPc.page);
  await addProduct(oldPc.page, { name: 'سكر أبيض', price: '30', cost: '25', qty: '40', barcode: '622000111' });
  await sellOne(oldPc.page, '622000111', '30');
  await go(oldPc.page, '/backup');
  await oldPc.app.evaluate(({ dialog }, f) => { dialog.showSaveDialog = (async () => ({ canceled: false, filePath: f })) as any; }, flashFile);
  await oldPc.page.getByRole('button', { name: /حفظ نسخة على فلاشة/ }).click();
  await expect.poll(() => existsSync(flashFile)).toBe(true);
  await oldPc.app.close();

  const newPc = await launch(); // empty data folder = fresh install
  await expect(newPc.page.getByText(/عندي نسخة احتياطية/)).toBeVisible();
  await newPc.page.getByRole('button', { name: /عندي نسخة احتياطية/ }).click();
  await newPc.app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any; }, flashFile);
  await newPc.page.getByRole('button', { name: /اختيار ملف نسخة احتياطية/ }).click();
  await expect(newPc.page.getByText(/تم فحص الملف: سليم/)).toBeVisible();
  await expect(newPc.page.locator('td', { hasText: 'سوبر ماركت البركة' })).toBeVisible();
  await expect(newPc.page.getByText(/1 منتج • 1 فاتورة/)).toBeVisible();
  await expect(newPc.page.getByText(/سيتم استبدال كل البيانات/)).toHaveCount(0); // nothing to replace on a fresh install
  await newPc.page.getByText('فهمت وأريد استعادة هذه النسخة').click();
  await newPc.page.getByRole('button', { name: /استعادة الآن/ }).click();
  await expect(newPc.page.getByText('تمت الاستعادة والتحقق من البيانات بنجاح')).toBeVisible();
  await newPc.page.getByRole('button', { name: 'متابعة لتسجيل الدخول' }).click();
  await loginAs(newPc.page, 'أحمد المدير', '1234');
  await go(newPc.page, '/products');
  await expect(newPc.page.locator('tr', { hasText: 'سكر أبيض' })).toContainText('39');
  await go(newPc.page, '/sales');
  await expect(newPc.page.locator('tbody tr')).toHaveCount(1);
  await newPc.app.close();
});

test('a corrupted file chosen for restore is refused with a clear message and current data is untouched', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbm-bad-'));
  const bad = join(dir, 'broken.sbmbak');
  writeFileSync(bad, Buffer.alloc(4096, 7));
  const { app, page } = await launch();
  await setup(page);
  await addProduct(page, { name: 'شاي', price: '20', cost: '15', qty: '10', barcode: '622000222' });
  await go(page, '/backup');
  await page.getByRole('button', { name: /استعادة نسخة/ }).click();
  await app.evaluate(({ dialog }, f) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [f] })) as any; }, bad);
  await page.getByRole('button', { name: /اختيار ملف نسخة احتياطية/ }).click();
  await expect(page.getByText('ملف النسخة الاحتياطية غير صالح أو تالف.').first()).toBeVisible();
  await page.keyboard.press('Escape');
  await go(page, '/products');
  await expect(page.locator('tr', { hasText: 'شاي' })).toContainText('10');
  await app.close();
});

test('license with an edition: activation shows the user limit and the users page enforces it', async () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const keyDir = mkdtempSync(join(tmpdir(), 'sbm-key-'));
  const pubFile = join(keyDir, 'pub.pem');
  writeFileSync(pubFile, publicKey.export({ type: 'spki', format: 'pem' }).toString());
  const { app, page } = await launch({ env: { SBM_TEST_LICENSE_PUBKEY: pubFile } });
  await setup(page);
  await go(page, '/license');
  const machine = await page.locator('input.num-input').first().inputValue();
  const b64 = (x: Buffer) => x.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const data = Buffer.from(JSON.stringify({ v: 1, id: 'E2E-1', type: 'permanent', customer: 'سوبر ماركت البركة', machine, issued: '2026-10-01', expires: null, edition: 'basic' }));
  const key = `SBM1.${b64(data)}.${b64(sign(null, Buffer.concat([Buffer.from('SBM1.'), data]), privateKey))}`;
  await page.locator('textarea').fill(key);
  await page.getByRole('button', { name: 'تفعيل', exact: true }).click();
  await expect(page.getByText('مفعّل — ترخيص دائم')).toBeVisible();
  await expect(page.getByText(/الباقة الأساسية — الحد الأقصى للمستخدمين النشطين: 2/)).toBeVisible();

  await go(page, '/users');
  await expect(page.getByText('المستخدمون النشطون: 1 من 2')).toBeVisible();
  await page.getByRole('button', { name: /مستخدم جديد/ }).click();
  const inputs = page.locator('.modal input');
  await inputs.nth(0).fill('سارة');
  await inputs.nth(1).fill('sara');
  await inputs.nth(2).fill('1234');
  await page.locator('.modal').getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('المستخدمون النشطون: 2 من 2')).toBeVisible();
  await expect(page.getByRole('button', { name: /مستخدم جديد/ })).toBeDisabled();
  await expect(page.getByText(/وصلت للحد الأقصى لعدد المستخدمين النشطين في ترخيصك/)).toBeVisible();
  // disabling a user frees the seat (history is kept)
  await page.locator('tr', { hasText: 'سارة' }).click();
  await page.locator('.modal label.check input').uncheck();
  await page.locator('.modal').getByRole('button', { name: 'حفظ' }).click();
  await expect(page.getByText('المستخدمون النشطون: 1 من 2')).toBeVisible();
  await expect(page.getByRole('button', { name: /مستخدم جديد/ })).toBeEnabled();
  await app.close();
});
