import { test, expect } from '@playwright/test';
import { addProduct, go, launch, setup, shot } from './helpers';

// Pepsi: sold by the can, bought and counted by the dozen (12 cans). No unit/weight question at the till.
test('packaging: add by dozen + cans, sell a can with one click, count 10 dozens + 5 cans', async () => {
  const { app, page } = await launch();
  await setup(page);

  await go(page, '/products/new');
  await page.locator('#p-selling .switch').click();
  await page.locator('#p-pack-unit').selectOption({ label: 'دستة' });
  await page.locator('#p-pack-count').fill('12');
  await expect(page.getByText('1 دستة = 12 قطعة')).toBeVisible();
  await page.locator('#p-base-unit').selectOption({ label: 'كانز' });
  await expect(page.getByText('1 دستة = 12 كانز')).toBeVisible();
  await page.locator('#pname').fill('بيبسي كانز');
  await page.locator('#p-price').fill('30');
  await page.locator('#p-cost').fill('300'); // the dozen
  await expect(page.getByText(/تكلفة الكانز: 25/)).toBeVisible();
  await page.locator('#p-opening-packs').fill('10');
  await page.locator('#p-opening').fill('5');
  await expect(page.getByText(/= 125 كانز/)).toBeVisible();
  await shot(page, '30-product-pack');
  await page.getByRole('button', { name: 'حفظ', exact: true }).click();
  await expect(page.locator('.page-header h1')).toContainText('بيبسي كانز');
  await expect(page.getByText(/125\s*كانز/).first()).toBeVisible(); // saved stock = 10 x 12 + 5
  await expect(page.getByText('10 دستة + 5 كانز')).toBeVisible();

  // the edit form reopens with the same packaging
  await page.getByRole('link', { name: /تعديل/ }).first().click();
  await expect(page.locator('#p-pack-unit')).toHaveValue(await page.locator('#p-pack-unit option', { hasText: 'دستة' }).getAttribute('value') as string);
  await expect(page.locator('#p-pack-count')).toHaveValue('12');
  await expect(page.locator('#p-cost')).toHaveValue(/300/);

  // a carton product added through the shared helper too
  await addProduct(page, { name: 'شيبسي طماطم', price: '10', cost: '84', qty: '5', unit: 'كيس', pack: { unit: 'كرتونة', count: '12', packs: '10' } });

  // POS: one click / Enter adds ONE can at the can price — no grams/dozen/amount dialog
  await page.getByRole('link', { name: /بيع جديد/ }).first().click();
  await page.locator('input.num-input').first().fill('0');
  await page.getByRole('button', { name: 'فتح الوردية وبدء البيع' }).click();
  const search = page.getByPlaceholder(/ابحث باسم المنتج/);
  await search.fill('بيبسي');
  await search.press('Enter');
  await expect(page.locator('.cart-line')).toHaveCount(1);
  await expect(page.locator('.modal')).toHaveCount(0);
  await page.locator('.tile', { hasText: 'بيبسي' }).click();
  await expect(page.locator('.cart-line .q').first()).toContainText('2');
  await expect(page.locator('.cart-totals .grand')).toContainText('60');
  await page.locator('.tile', { hasText: 'شيبسي' }).click();
  await expect(page.locator('.cart-totals .grand')).toContainText('70');
  await shot(page, '31-pos-cans');

  // stocktake: "[10] دستة + [5] كانز"
  await go(page, '/stocktake');
  await page.getByRole('button', { name: /بدء جرد جديد/ }).click();
  await page.getByRole('button', { name: 'بدء الجرد' }).click();
  const row = page.locator('tr', { hasText: 'بيبسي كانز' });
  await expect(row).toContainText('10 دستة + 5 كانز'); // the cart above was not paid: nothing left the shelf
  await row.getByLabel('دستة').fill('10');
  await row.getByLabel('كانز').fill('3');
  await row.getByLabel('كانز').press('Enter');
  await expect(row).toContainText('-2');
  await shot(page, '32-stocktake-packs');
  await app.close();
});
