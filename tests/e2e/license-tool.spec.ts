import { test, expect, _electron as electron } from '@playwright/test';
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseLicenseKey } from '../../src/main/license/core';

// The vendor's offline browser tool (tools/license/license-tool.html) must produce keys and activation codes
// that the application itself accepts — exactly like tools/license/issue.mjs. It runs in Electron's Chromium.
const MACHINE = '9F2C1-0B7A4-33D10-AA0F2';

test('license tool: create key, issue permanent + temporary codes, the app accepts them', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sbm-tool-'));
  const app = await electron.launch({ args: [join(__dirname, 'fixtures/license-tool-main.cjs'), '--no-sandbox'], env: { ...process.env, SBM_TOOL_DOWNLOADS: dir } });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState('domcontentloaded');

    // 1. key creation (test key in a temp folder, deleted at the end)
    await page.getByRole('tab', { name: /إنشاء المفتاح/ }).click();
    await page.getByRole('button', { name: 'إنشاء المفتاح' }).click();
    const keyFile = join(dir, 'sabermarko-private-key.pem');
    await expect.poll(() => existsSync(keyFile) && readFileSync(keyFile, 'utf8').includes('-----END PRIVATE KEY-----')).toBe(true);
    const publicPem = await page.locator('#pub').inputValue();
    expect(publicPem).toMatch(/^-----BEGIN PUBLIC KEY-----/);
    // the downloaded private key matches the shown public key, and Node (tools/license/issue.mjs) can use it
    const nodePriv = createPrivateKey(readFileSync(keyFile));
    expect(createPublicKey(nodePriv).export({ type: 'spki', format: 'pem' }).toString().trim()).toBe(publicPem.trim());
    expect(sign(null, Buffer.from('x'), nodePriv).length).toBe(64);

    // 2. permanent activation code
    await page.getByRole('tab', { name: 'توليد كود تفعيل' }).click();
    await page.locator('#keyfile').setInputFiles(keyFile);
    await expect(page.locator('#keyinfo')).toContainText('تم تحميل المفتاح');
    await page.locator('#machine').fill(' 9f2c1-0b7a4-33d10-aa0f2 ');
    await page.locator('#customer').fill('سوبر ماركت البركة');
    await page.locator('#edition').selectOption('standard');
    await page.getByRole('button', { name: 'توليد كود التفعيل' }).click();
    const permanent = await page.locator('#code').inputValue();
    const now = Date.now();
    const p = parseLicenseKey(permanent, publicPem, MACHINE, now);
    expect(p.ok).toBe(true);
    if (p.ok) {
      expect(p.payload).toMatchObject({ v: 1, type: 'permanent', customer: 'سوبر ماركت البركة', machine: MACHINE, expires: null, edition: 'standard' });
    }
    // bound to the machine; an edited code and a code checked against another key are refused
    expect(parseLicenseKey(permanent, publicPem, 'AAAAA-BBBBB-CCCCC-DDDDD', now)).toEqual({ ok: false, error: 'LICENSE_WRONG_MACHINE' });
    const [head, data, sig] = permanent.split('.');
    const edited = `${head}.${Buffer.from(Buffer.from(data, 'base64url').toString('utf8').replace('permanent', 'temporary')).toString('base64url')}.${sig}`;
    expect(parseLicenseKey(edited, publicPem, MACHINE, now).ok).toBe(false);
    const foreignPub = generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString();
    expect(parseLicenseKey(permanent, foreignPub, MACHINE, now)).toEqual({ ok: false, error: 'LICENSE_INVALID' });

    // 3. temporary code: 30 days, then expired
    await page.locator('#type').selectOption('temporary');
    await page.locator('#days').fill('30');
    await page.locator('#edition').selectOption('');
    await page.locator('#maxusers').fill('3');
    await page.getByRole('button', { name: 'توليد كود التفعيل' }).click();
    const temporary = await page.locator('#code').inputValue();
    const t = parseLicenseKey(temporary, publicPem, MACHINE, now);
    expect(t.ok).toBe(true);
    if (t.ok) expect(t.payload).toMatchObject({ type: 'temporary', maxUsers: 3 });
    expect(parseLicenseKey(temporary, publicPem, MACHINE, now + 32 * 86_400_000)).toEqual({ ok: false, error: 'LICENSE_EXPIRED' });

    // 4. input validation
    await page.locator('#machine').fill('123');
    await page.getByRole('button', { name: 'توليد كود التفعيل' }).click();
    await expect(page.locator('#issue-err')).toContainText('كود الجهاز غير صحيح');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
