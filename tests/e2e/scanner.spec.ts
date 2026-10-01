import { test, expect } from '@playwright/test';
import { addProduct, go, launch, setup } from './helpers';

/**
 * A barcode scanner "types" the code and presses Enter in a few milliseconds, and cashiers often scan
 * the same item several times in a row. Every scan must land on the invoice, in order, none lost.
 * (Found on a fast CI machine: a repeated code used to be wiped from the box by the previous lookup.)
 */
test('fast repeated scans are never lost', async () => {
  const { app, page } = await launch();
  await setup(page);
  await addProduct(page, { name: 'تونة قطع', price: '45', cost: '38', qty: '50', barcode: '6223000000017' });
  await addProduct(page, { name: 'فول مدمس', price: '20', cost: '15', qty: '50', barcode: '6223000000024' });
  await go(page, '/pos');
  await page.locator('input.num-input').first().fill('0');
  await page.getByRole('button', { name: 'فتح الوردية وبدء البيع' }).click();
  const search = page.getByPlaceholder(/ابحث باسم المنتج/);
  await search.click();
  // 4 x tuna, 2 x beans, 1 x tuna — typed with no delay like a USB scanner, without waiting for lookups
  for (const code of ['6223000000017', '6223000000017', '6223000000017', '6223000000024', '6223000000017', '6223000000024', '6223000000017']) {
    await page.keyboard.type(code, { delay: 0 });
    await page.keyboard.press('Enter');
  }
  await expect(page.locator('.cart-line')).toHaveCount(2);
  await expect(page.locator('.cart-line', { hasText: 'تونة قطع' }).locator('.q')).toContainText('5');
  await expect(page.locator('.cart-line', { hasText: 'فول مدمس' }).locator('.q')).toContainText('2');
  await expect(search).toHaveValue('');
  // an unknown code is reported and left in the box so the cashier can correct it
  await page.keyboard.type('9999999999999', { delay: 0 });
  await page.keyboard.press('Enter');
  await expect(page.getByText('لا يوجد منتج بالاسم أو الكود "9999999999999"')).toBeVisible();
  await expect(search).toHaveValue('9999999999999');
  await app.close();
});
