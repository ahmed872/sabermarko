# Vendor guide — licensing and releases

## 1. Generate YOUR signing key (once, on your own computer)

The repository ships a **development** public key. Its private key exists only in development environments,
so the release gate (`tools/release/check-release.mjs`) refuses to publish a release that still embeds it.

```bash
npm run license:keygen                                   # -> ~/.sabermarko-vendor-keys/private.pem
npm run license:keygen -- --out /media/usb/sbm-keys      # or any folder OUTSIDE a git repository
SBM_KEY_PASSPHRASE='...' npm run license:keygen          # optional: encrypt the private key
```

- The tool **refuses** to write the private key inside any git working tree.
- Only the public key is written into the repo (`src/main/license/public-key.ts`) together with its fingerprint.
- `.githooks/pre-commit` (enabled by `npm install`) and the CI secret scan block any private key, `.pem/.pfx/.p12`
  file, `.env` file or password from being committed.
- Back up the private key offline. Whoever has it can issue licenses; if you lose it you can no longer issue keys
  that existing installations accept.

## 2. Issue a license for a customer

The customer opens **الترخيص** and sends you the *machine code* (e.g. `9F2C1-0B7A4-…`).

```bash
npm run license:issue -- --machine 9F2C1-0B7A4-33D10-AA0F2 --customer "سوبر ماركت البركة" --type temporary --days 365
npm run license:issue -- --machine 9F2C1-... --customer "..." --type permanent --edition professional
npm run license:issue -- --machine 9F2C1-... --customer "..." --type permanent --max-users 8 --features multi-location
npm run license:verify -- SBM1.xxxx.yyyy --machine 9F2C1-...        # check any key against the app's public key
```

| Edition | `--edition` | Active users |
|---|---|---|
| الباقة الأساسية | `basic` | 2 |
| الباقة القياسية | `standard` | 5 |
| الباقة الاحترافية | `professional` | 15 |
| (no edition — legacy keys) | — | 10 |

`--max-users` overrides the edition. The limit is enforced in the service layer (`users.saveUser`), counts active
users only, and disabling a user frees a seat without deleting their history.
`license:issue` verifies every new key against the app's embedded public key before printing it.

## 3. Release
See [RELEASE.md](RELEASE.md): push a `vX.Y.Z` tag and `.github/workflows/release.yml` builds the Windows installer
on a Windows runner, runs the tests, writes `SHA256SUMS.txt` and publishes the GitHub Release. The installer is
**not code-signed**; a GitHub Release does not sign it.

## 4. Branding
Vendor identity (product name, company, support phone) lives in `src/shared/brand.ts` and is shown in About/License/receipt footer. Store branding (name, logo, address) is entered by each customer and lives only in their database.
