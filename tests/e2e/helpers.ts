import { _electron as electron, type ElectronApplication, type Page } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function launch(opts: { userData?: string; executablePath?: string; args?: string[] } = {}): Promise<{ app: ElectronApplication; page: Page; userData: string }> {
  const userData = opts.userData ?? mkdtempSync(join(tmpdir(), 'sbm-e2e-'));
  const app = await electron.launch({
    executablePath: opts.executablePath,
    args: opts.executablePath ? (opts.args ?? []) : [join(__dirname, '../..'), '--no-sandbox'],
    env: { ...process.env, SBM_USER_DATA: userData, SBM_LOG_STDOUT: '' },
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
