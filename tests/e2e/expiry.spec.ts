import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { go, launch, shot } from './helpers';

/** Expiry alert → review on the expiry screen → return that batch to its supplier (through the real UI). */
test('expiry dashboard: near-expiry batch returned to its supplier from the alert', async () => {
  const userData = mkdtempSync(join(tmpdir(), 'sbm-exp-'));
  execFileSync(process.execPath, [join(__dirname, '../../dist/tools/seed-demo.js'), userData]);
  const { app, page } = await launch({ userData });
  await page.getByRole('button', { name: 'الحاج محمود' }).click();
  await page.locator('input[type=password]').fill('1234');
  await page.getByRole('button', { name: /دخول/ }).click();
  // the dashboard warns about the yoghurt that expires within the "very near" tier
  await expect(page.getByText(/⚠️ يوجد 72 علبة من زبادي جهينة ستنتهي خلال \d+ يوم/).or(page.getByText(/⚠️ يوجد 72 قطعة من زبادي جهينة ستنتهي خلال \d+ يوم/))).toBeVisible();
  await go(page, '/inventory/expiry');
  await expect(page.getByRole('button', { name: /قريب جدًا/ })).toBeVisible();
  const row = page.locator('tr', { hasText: 'زبادي جهينة' }).filter({ hasText: 'قريب' }).first();
  await expect(row).toContainText('مراجعة إرجاع للمورد');
  await expect(row).toContainText('جهينة');
  await shot(page, '30-expiry-dashboard');
  await row.getByRole('button', { name: 'إرجاع للمورد' }).click();
  const dlg = page.locator('.modal');
  await expect(dlg.getByText(/سيُخصم من هذه الدفعة فقط/)).toBeVisible();
  await expect(dlg.locator('select').first()).toBeDisabled(); // supplier comes from the batch
  // more than the batch holds is blocked in the form (and in the engine)
  const qtyBox = dlg.locator('input.num-input').first();
  await qtyBox.fill('500');
  await expect(dlg.getByText('أكبر من كمية الدفعة')).toBeVisible();
  await qtyBox.fill('24');
  await dlg.getByRole('button', { name: 'تسجيل المرتجع' }).click();
  await expect(page.getByText('تم تسجيل المرتجع للمورد')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'زبادي جهينة' }).filter({ hasText: 'قريب' }).first()).toContainText('48');
  await go(page, '/purchases');
  await page.getByRole('button', { name: 'مرتجعات الشراء' }).click();
  await expect(page.locator('tr', { hasText: 'قرب انتهاء الصلاحية' })).toBeVisible();
  await app.close();
});
