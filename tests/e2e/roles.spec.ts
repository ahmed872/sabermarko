import { test, expect } from '@playwright/test';
import { addProduct, go, launch, loginAs, setup, shot } from './helpers';

test('cashier: limited menu, manager approval for a large discount, return, day close', async () => {
  const { app, page } = await launch();
  await setup(page);
  await addProduct(page, { name: 'زيت ذرة', price: '100', cost: '80', qty: '20', barcode: '5550001' });
  // admin creates a cashier
  await go(page, '/users');
  await page.getByRole('button', { name: /مستخدم جديد/ }).click();
  const inputs = page.locator('.modal input');
  await inputs.nth(0).fill('منى');
  await inputs.nth(1).fill('mona');
  await inputs.nth(2).fill('5678');
  await page.getByRole('button', { name: 'حفظ' }).click();
  await expect(page.locator('tr', { hasText: 'منى' })).toContainText('كاشير');
  await page.getByTitle('تسجيل الخروج').click();

  // cashier logs in and lands on the POS
  await loginAs(page, 'منى', '5678');
  await expect(page.getByRole('heading', { name: 'فتح الوردية' })).toBeVisible();
  await expect(page.locator('.nav').getByText('التقارير')).toHaveCount(0);
  await expect(page.locator('.nav').getByText('المستخدمون والصلاحيات')).toHaveCount(0);
  await page.locator('input.num-input').first().fill('200');
  await page.getByRole('button', { name: 'فتح الوردية وبدء البيع' }).click();
  const box = page.getByPlaceholder(/ابحث باسم المنتج/);
  await box.fill('5550001');
  await box.press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await page.keyboard.press('F8');
  await page.getByRole('button', { name: 'نسبة %' }).click();
  await page.locator('.modal input.num-input').fill('25');
  await page.getByRole('button', { name: 'تطبيق' }).click();
  await expect(page.locator('.cart-totals .grand .num')).toHaveText(/^75(\.00)? ج\.م$/);
  await page.keyboard.press('F9');
  await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
  // 25% > 10% cashier limit -> supervisor override
  await expect(page.getByText('موافقة مدير')).toBeVisible();
  await shot(page, '30-approval');
  const approval = page.locator('.modal', { hasText: 'اسم مستخدم المدير' });
  await approval.locator('input').nth(0).fill('admin');
  await approval.locator('input[type=password]').fill('wrong');
  await approval.getByRole('button', { name: 'موافقة' }).click();
  await expect(page.getByText('بيانات المدير غير صحيحة')).toBeVisible();
  await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
  await approval.locator('input').nth(0).fill('admin');
  await approval.locator('input[type=password]').fill('1234');
  await approval.getByRole('button', { name: 'موافقة' }).click();
  await expect(page.getByText(/تم حفظ الفاتورة رقم/)).toBeVisible();
  await expect(page.locator('.change-box').first()).toContainText('75');
  await page.keyboard.press('Enter');
  await expect(page.locator('.nav .foot, .sidebar .foot')).toContainText('275'); // 200 opening + 75 cash
  // cashier cannot open admin pages even by URL
  await go(page, '/users');
  await expect(page.getByText('ليس لديك صلاحية لعرض هذه الصفحة')).toBeVisible();
  await page.getByTitle('تسجيل الخروج').click();

  // admin: the audit log shows who approved; do a partial return and close the day
  await loginAs(page, 'أحمد المدير', '1234');
  await go(page, '/audit');
  await expect(page.locator('tr', { hasText: 'خصم على فاتورة' })).toContainText('أحمد المدير');
  await go(page, '/sales');
  await page.locator('tbody tr').first().click();
  await expect(page.getByText(/موافقة: أحمد المدير/)).toBeVisible();
  await page.locator('.modal-foot').getByRole('button', { name: 'مرتجع', exact: true }).click();
  await page.locator('.modal').last().getByRole('button', { name: 'الكل' }).click();
  await page.locator('.modal').last().getByRole('button', { name: 'كارت' }).click(); // admin has no open drawer
  await page.getByRole('button', { name: 'تأكيد المرتجع' }).click();
  await expect(page.getByText(/تم المرتجع/)).toBeVisible();
  await page.keyboard.press('Escape');
  await go(page, '/day-close');
  await expect(page.getByText('الملخص المالي')).toBeVisible();
  await expect(page.locator('tr', { hasText: 'صافي المبيعات' })).toContainText('0');
  await shot(page, '31-day-close');
  await app.close();
});
