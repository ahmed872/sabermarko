import { test, expect } from '@playwright/test';
import { launch, shot } from './helpers';

test('first run renders onboarding', async () => {
  const { app, page } = await launch();
  await expect(page.getByText('أهلًا بك')).toBeVisible();
  await shot(page, '01-welcome');
  await app.close();
});
