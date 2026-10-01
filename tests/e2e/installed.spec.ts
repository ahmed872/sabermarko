/**
 * Runs against the INSTALLED production package (not the dev build).
 *   SBM_EXECUTABLE="/opt/SaberMarko POS/sabermarko" npx playwright test tests/e2e/installed.spec.ts
 * The uninstall/reinstall steps are driven by scripts/verify-installer.sh.
 */
import { test, expect } from '@playwright/test';
import { addProduct, go, launch, loginAs, sellOne, setup, shot } from './helpers';

const exe = process.env.SBM_EXECUTABLE;
const userData = process.env.SBM_TEST_USERDATA;
const phase = process.env.SBM_PHASE ?? 'first';

test.skip(!exe || !userData, 'set SBM_EXECUTABLE and SBM_TEST_USERDATA');

test(`installed app — phase ${phase}`, async () => {
  const { app, page } = await launch({ executablePath: exe!, userData: userData! });
  if (phase === 'first') {
    // clean install -> first launch -> onboarding -> trial -> database created -> sale
    await expect(page.getByText('أهلًا بك')).toBeVisible();
    await setup(page);
    await expect(page.getByText(/نسخة تجريبية — متبقٍ 20 يوم/)).toBeVisible();
    await addProduct(page, { name: 'عصير مانجو', price: '12', cost: '9', qty: '30', barcode: '111222333' });
    await sellOne(page, '111222333', '20');
    await go(page, '/backup');
    await page.getByRole('button', { name: /نسخة احتياطية الآن/ }).click();
    await expect(page.getByText('تم إنشاء النسخة الاحتياطية بنجاح')).toBeVisible();
    await shot(page, '20-installed-first');
  } else if (phase === 'restart') {
    // data survived the restart; make a second sale, then restore the backup taken before it
    await loginAs(page, 'أحمد المدير', '1234');
    await go(page, '/products');
    await expect(page.locator('tr', { hasText: 'عصير مانجو' })).toContainText('29');
    await sellOne(page, '111222333', '20');
    await go(page, '/products');
    await expect(page.locator('tr', { hasText: 'عصير مانجو' })).toContainText('28');
    await go(page, '/backup');
    await page.locator('tr', { hasText: 'يدوي' }).first().getByRole('button', { name: 'استعادة' }).click();
    await page.getByText('أفهم ذلك وأريد المتابعة').click();
    await page.getByRole('button', { name: 'استعادة الآن' }).click();
    await expect(page.getByText('تسجيل الدخول').or(page.getByText('سجّل الدخول للمتابعة'))).toBeVisible();
    await loginAs(page, 'أحمد المدير', '1234');
    await go(page, '/products');
    await expect(page.locator('tr', { hasText: 'عصير مانجو' })).toContainText('29'); // back to the backup state
  } else if (phase === 'updated') {
    // version upgrade installed over the old one: migrations ran, data and trial preserved
    await expect(page.getByText(`الإصدار ${process.env.SBM_EXPECT_VERSION}`)).toBeVisible();
    await loginAs(page, 'أحمد المدير', '1234');
    await go(page, '/products');
    await expect(page.locator('tr', { hasText: 'عصير مانجو' })).toContainText('29');
    await sellOne(page, '111222333', '20');
  } else if (phase === 'reinstalled') {
    // after uninstall + reinstall: data and trial are kept (never deleted on uninstall)
    await expect(page.getByText('سجّل الدخول للمتابعة')).toBeVisible();
    await loginAs(page, 'أحمد المدير', '1234');
    await expect(page.getByText(/نسخة تجريبية — متبقٍ/)).toBeVisible();
    await go(page, '/sales');
    await expect(page.locator('tbody tr')).toHaveCount(1);
    await shot(page, '21-installed-reinstalled');
  }
  await app.close();
});
