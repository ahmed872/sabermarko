# SaberMarko POS — سابر ماركو لإدارة المحلات

نظام نقاط بيع وإدارة محلات تجزئة (بقالة، ميني ماركت، سوبر ماركت) — عربي بالكامل، يعمل بدون إنترنت، على ويندوز ولينكس.

**بسيط من الخارج — قوي من الداخل.** نفس البرنامج يخدم محلًا صغيرًا بكاشير واحد (الوضع البسيط) وسوبر ماركت به عدة كاشير ومخازن وصلاحية ودفعات (الوضع المتقدم).

- دليل المستخدم: [`docs/USER_GUIDE.md`](docs/USER_GUIDE.md)
- المعمارية وقواعد العمل: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- دليل البائع (الترخيص والإصدار): [`docs/VENDOR_GUIDE.md`](docs/VENDOR_GUIDE.md)
- نماذج فواتير حقيقية من البرنامج: [`docs/samples/`](docs/samples)

## Tech stack

| Layer | Choice |
|---|---|
| Desktop shell | Electron 44 — sandboxed renderer, context isolation, single whitelisted IPC channel, strict CSP |
| Database | SQLite via better-sqlite3 (WAL, `synchronous=FULL`, foreign keys, migrations via `user_version`) |
| Engine | TypeScript services in the main process (all business rules + authorization) |
| UI | React 19 + TanStack Query, hand-built Arabic RTL design system, IBM Plex Sans Arabic bundled offline |
| Tests | Vitest (business logic) + Playwright driving the real Electron app and the installed package |
| Packaging | electron-builder: Windows NSIS, Linux deb + AppImage |

## Development

```bash
npm install
node node_modules/electron/install.js   # if your npm skips postinstall scripts
npm run build                            # typecheck + main/preload (esbuild) + renderer (vite)
npm start                                # run the app
```

Live renderer development: run `npx vite` and start Electron with `SBM_DEV_URL=http://localhost:5173 npm start`.

Useful environment variables: `SBM_USER_DATA=<dir>` (isolated data folder), `SBM_DEVTOOLS=1` (devtools in packaged builds), `SBM_LOG_STDOUT=1`.

## Tests

```bash
npm test                                      # 67 business-logic tests (sales, inventory, units, costing, cash, credit,
                                              # suppliers, expiry, licensing, backup, permissions, performance, intelligence)
BUILD_TOOLS=1 node scripts/build-main.mjs     # builds the demo-store generator used by the insights E2E
xvfb-run -a npx playwright test               # E2E on the real app (Linux CI needs xvfb)
```

E2E suites: first-run onboarding · full sale with barcode + weighed cheese + receipt · cashier limits + manager override + return + day close · power loss (SIGKILL) durability + corrupted DB → recovery screen → restore · smart suggestions approve → POS applies the offer.

## Building installers

```bash
npm run dist:linux        # release/SaberMarko-POS-<v>-amd64.deb and .AppImage
npm run dist:win          # release/SaberMarko-POS-Setup-<v>.exe  (on Linux this needs wine + wine32)
sudo ./scripts/verify-installer.sh release/SaberMarko-POS-1.0.0-amd64.deb [newer.deb]
```

`verify-installer.sh` installs the real package and drives it: clean install → first launch → trial → database → sale → backup → restart → restore → uninstall (data kept) → reinstall → optional version update.

Windows code signing: set `CSC_LINK` / `CSC_KEY_PASSWORD` to the vendor's code-signing certificate before `dist:win` (an unsigned installer triggers SmartScreen warnings).

## Demo mode

`node dist/tools/seed-demo.js <dir>` creates a realistic 60-day store (separate from the app; production installs always start clean). Launch it with `SBM_USER_DATA=<dir> npm start`, login `admin / 1234`.

## Where the store's data lives

| OS | Path |
|---|---|
| Windows | `%APPDATA%\SaberMarko POS\data\store.db` |
| Linux | `~/.config/SaberMarko POS/data/store.db` |

Backups default to `Documents/SaberMarko Backups` (configurable). Uninstalling never deletes the database, backups or license.
