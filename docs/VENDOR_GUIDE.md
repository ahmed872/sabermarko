# Vendor guide — licensing and releases

## 1. Generate YOUR signing key (once, before the first release)

The repository contains a development public key whose private key is **not** in the repository.
Before selling, generate your own key pair on a trusted machine:

```bash
npm run license:keygen -- --force
```

- Writes `.vendor-keys/private.pem` (git-ignored — back it up offline; whoever has it can issue licenses) and updates `src/main/license/public-key.ts`.
- Rebuild the installers afterwards. Licenses signed by another key will be rejected.

## 2. Issue a license for a customer

The customer opens **الترخيص** and sends you the *machine code* (e.g. `9F2C1-0B7A4-…`).

```bash
# 1-year temporary license
npm run license:issue -- --machine 9F2C1-0B7A4-33D10-AA0F2 --customer "سوبر ماركت البركة" --type temporary --days 365
# temporary until a date
npm run license:issue -- --machine 9F2C1-... --customer "..." --type temporary --expires 2027-12-31
# permanent
npm run license:issue -- --machine 9F2C1-... --customer "..." --type permanent
# site key valid on any machine (use sparingly)
npm run license:issue -- --machine '*' --customer "..." --type permanent
```

Send the printed `SBM1....` key to the customer; they paste it in **كود التفعيل**. No internet needed.

## 3. Release checklist
1. Bump `version` in `package.json`.
2. `npm test` and `xvfb-run -a npx playwright test`.
3. `npm run dist:win` (on Windows, or Linux with wine + wine32) and `npm run dist:linux`.
4. Sign the Windows installer (`CSC_LINK`, `CSC_KEY_PASSWORD`).
5. Linux: `sudo ./scripts/verify-installer.sh release/<old>.deb release/<new>.deb`.
6. Windows: install on a clean Windows 10/11 VM — first run, sale, print to the real thermal printer, restart, upgrade over the previous version, uninstall (data must remain in `%APPDATA%\SaberMarko POS`).

## 4. Branding
Vendor identity (product name, company, support phone) lives in `src/shared/brand.ts` and is shown in About/License/receipt footer. Store branding (name, logo, address) is entered by each customer and lives only in their database.
