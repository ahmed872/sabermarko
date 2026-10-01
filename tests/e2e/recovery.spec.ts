import { test, expect } from '@playwright/test';
import { closeSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { addProduct, go, launch, loginAs, sellOne, setup } from './helpers';

test('power loss right after a sale keeps the data; a corrupted database opens the recovery screen and restores', async () => {
  const first = await launch();
  const { page, userData } = first;
  await setup(page);
  await addProduct(page, { name: 'مياه معدنية', price: '7', cost: '5', qty: '100', barcode: '999000111' });
  await go(page, '/backup');
  await expect(page.getByText('لم يتم إنشاء أي نسخة احتياطية بعد')).toBeVisible();
  await page.getByRole('button', { name: /إنشاء نسخة الآن/ }).click();
  await expect(page.getByText('تم إنشاء النسخة الاحتياطية والتحقق منها بنجاح')).toBeVisible();
  await expect(page.getByText('الحالة: سليمة وتم التحقق منها')).toBeVisible();
  await sellOne(page, '999000111', '10');
  // simulate a power cut: kill -9, no graceful shutdown, no WAL checkpoint
  first.app.process().kill('SIGKILL');
  await new Promise((r) => setTimeout(r, 800));

  const second = await launch({ userData });
  await expect(second.page.getByText('سجّل الدخول للمتابعة')).toBeVisible(); // database opened cleanly, no recovery
  await loginAs(second.page, 'أحمد المدير', '1234');
  await go(second.page, '/products');
  await expect(second.page.locator('tr', { hasText: 'مياه معدنية' })).toContainText('99'); // the committed sale survived
  await second.app.close();

  // corrupt the database file on disk (bad sector / interrupted write)
  const fd = openSync(join(userData, 'data', 'store.db'), 'r+');
  writeSync(fd, Buffer.alloc(16384, 0xa5), 0, 16384, 4096);
  closeSync(fd);

  const third = await launch({ userData });
  await expect(third.page.getByText('استعادة البيانات')).toBeVisible();
  await third.page.locator('.auth-card button', { hasText: 'سوبر ماركت البركة' }).first().click();
  await expect(third.page.getByText(/تم فحص الملف: سليم/)).toBeVisible();
  await expect(third.page.getByText(/1 منتج/)).toBeVisible();
  const restoreBtn = third.page.getByRole('button', { name: /استعادة الآن/ });
  await expect(restoreBtn).toBeDisabled(); // explicit confirmation required
  await third.page.getByText('فهمت وأريد استعادة هذه النسخة').click();
  await restoreBtn.click();
  await expect(third.page.getByText('تمت الاستعادة والتحقق من البيانات بنجاح')).toBeVisible();
  await third.page.getByRole('button', { name: 'متابعة لتسجيل الدخول' }).click();
  await expect(third.page.getByText('سجّل الدخول للمتابعة')).toBeVisible();
  await loginAs(third.page, 'أحمد المدير', '1234');
  await go(third.page, '/products');
  await expect(third.page.locator('tr', { hasText: 'مياه معدنية' })).toContainText('100'); // state of the backup
  await third.app.close();
});
