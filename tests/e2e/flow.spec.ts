import { test, expect } from '@playwright/test';
import { addProduct, go, launch, setup, shot } from './helpers';

test('setup → products → shift → sale → invoice', async () => {
  const { app, page } = await launch();
  await setup(page);
  await shot(page, '02-dashboard-empty');
  await addProduct(page, { name: 'شيبسي طماطم', price: '10', cost: '7', qty: '50', barcode: '6221031490018', fav: true });
  await addProduct(page, { name: 'كوكاكولا 330 مل', price: '15', cost: '12', qty: '24', fav: true });
  await addProduct(page, { name: 'جبنة رومي', price: '180', cost: '140', qty: '5', unit: 'كيلو', fav: true });
  await shot(page, '03-product-detail');

  await page.getByRole('link', { name: /بيع جديد/ }).first().click();
  await expect(page.getByRole('heading', { name: 'فتح الوردية' })).toBeVisible();
  await page.locator('input.num-input').first().fill('500');
  await page.getByRole('button', { name: 'فتح الوردية وبدء البيع' }).click();
  // barcode scan (typed into search + Enter)
  const search = page.getByPlaceholder(/ابحث باسم المنتج/);
  await search.fill('6221031490018');
  await search.press('Enter');
  await search.fill('6221031490018');
  await search.press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(1); // second scan merged into the same line
  await expect(page.locator('.cart-line .q').first()).toContainText('2');
  await page.locator('.tile', { hasText: 'كوكاكولا' }).click();
  await page.locator('.tile', { hasText: 'جبنة رومي' }).click();
  await expect(page.getByText(/جبنة رومي — /)).toBeVisible();
  await page.locator('.modal input.num-input').fill('250');
  await page.getByRole('button', { name: /إضافة/ }).click();
  await expect(page.locator('.cart-line')).toHaveCount(3);
  await expect(page.locator('.cart-totals .grand')).toContainText('80'); // 2x10 + 15 + 45
  await shot(page, '04-pos-cart');
  await page.keyboard.press('F9');
  await expect(page.getByText('المبلغ المستلم من العميل')).toBeVisible();
  await page.locator('.modal input.num-input').fill('100');
  await expect(page.locator('.change-box')).toContainText('20');
  await shot(page, '05-payment');
  await page.getByRole('button', { name: /تأكيد وحفظ الفاتورة/ }).click();
  await expect(page.getByText(/تم حفظ الفاتورة رقم/)).toBeVisible();
  await page.waitForTimeout(800);
  await shot(page, '06-receipt');
  await page.keyboard.press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(0);
  // stock decreased: cheese 5kg -> 4.75
  await go(page, '/products');
  await expect(page.locator('tr', { hasText: 'جبنة رومي' })).toContainText('4.75');
  await expect(page.locator('tr', { hasText: 'شيبسي طماطم' })).toContainText('48');
  await go(page, '/');
  await expect(page.locator('.stat.primary .value')).toContainText('80');
  await shot(page, '07-dashboard-after-sale');
  await app.close();
});
