# Architecture & business rules

## Process model
- **Main process** owns the database and every business rule (`src/main/services/*`). Each service checks its own permission (`requirePerm`) — the renderer is never trusted.
- **Preload** exposes exactly one function: `window.sbm.invoke(channel, payload)` over a single IPC channel; the main process rejects calls from any other frame URL.
- **Renderer** is sandboxed (no Node, no filesystem), strict CSP, navigation and `window.open` blocked, devtools disabled in packaged builds.
- Errors: services throw `AppError(code)`; the renderer shows only the Arabic message for the code. SQLite/technical details go to `logs/app.log`.

## Data rules
| Concept | Storage |
|---|---|
| Money | INTEGER minor units (piasters) |
| Quantity | INTEGER thousandths of the product's **base unit** (1 piece = 1000, 250 g of a per-kg product = 250) |
| Unit conversion | `product_units.factor` = base-milli in one unit (carton of 30 = 30000; gram of kg = 1) |
| Average cost | REAL piasters per base unit (4 decimals) |
| Time | local ISO text + `business_date` for reporting |

Durability: WAL + `synchronous=FULL` + foreign keys. Every multi-table operation (sale, return, void, purchase, stocktake, payment, expense) is one transaction — all or nothing. Checkout is idempotent through a client reference (double-click / retry never creates two invoices).

## Inventory engine
- `applyMovement` is the only way stock changes; each movement stores type, signed qty, before/after, unit cost, reference, user, note.
- Weighted Average Cost updated on every receipt (purchase landed cost includes the invoice-level discount and extra charges, allocated exactly with largest-remainder).
- **COGS is snapshotted on every sale line**, so later cost changes never alter historical profit.
- Batches/expiry (optional): purchases require an expiry date for tracked products; sales consume First-Expiry-First-Out; returns put quantity back into the batches it came from.
- Stocktake: difference = counted − stock *at confirmation* (sales during the count are respected); uncounted items are untouched.
- Locations: default "المحل"; warehouses/fridges/branches are optional, with transfers.

## Sales
- `priceCart` is authoritative (used for the live POS preview and at checkout): price list → unit price → manual override (needs permission) → best promotion → manual line discount → invoice discount allocated across lines → tax (inclusive/exclusive) → cash rounding.
- Thresholds: a cashier's manual discount above `sales.maxDiscountPct` (or their own limit) needs `pos.discount_large` or a manager's credentials (supervisor override, audited with `approved_by`).
- Credit sales need a customer, the feature enabled, `pos.credit_sale` (or approval) and respect the customer's credit limit.
- Returns are proportional and exact: the last return of a line takes the exact remainder of revenue, tax and cost. Damaged returns refund the customer but keep the cost (a recorded loss).
- Voids: same business day only, reverse stock, drawer cash and customer debt with ledger entries.

## Cash & shifts
Expected cash = opening + Σ cash movements (cash sales, refunds, expenses from the drawer, withdrawals, deposits, collections, supplier payments, cash purchases). Closing records counted cash and variance.

## Reporting — single source of truth
`financialSummary` computes everything (net revenue = sales − returns by return date; COGS = sales cost − returned cost; gross profit; expenses; net profit). Dashboard, daily closing, cashier report and profit report all call it — tests assert they agree.

## Smart retail intelligence (`analytics.ts`, `recommendations.ts`)
- Metrics per product: velocity (window, last 7 days, previous window, trend), invoices, days of cover, turnover, margin, profit, idle days, typical gap between sales (180 days), expiry at-risk quantity (FEFO-aware).
- Classes are adaptive: hot/slow by percentiles of *this store's* selling products (only when ≥ 5 products have data); dead = idle longer than max(setting, 3 × the product's own typical gap); excess = cover above max(setting, 3 × its category's median cover); new products (< 14 days) are not judged.
- Suggestions (clearance, slow+fast pairing, quantity discount, bundles from basket data, expiry): every option is simulated with live prices and average cost. An option that loses money, falls under the minimum margin, exceeds the maximum discount or sells below cost is never shown as good; a safer alternative is chosen and the rejected option is explained. Using a fast mover as a gift is capped per invoice and checked against its stock.
- Basket analysis only reports pairs with enough invoices (support) and lift ≥ 1.2. Seasonality needs ≥ 12 months of history. No randomness, no claimed ML.
- Lifecycle: suggest → owner approves (server-side safety check; unsafe offers need `promotions.override`) → promotion active in POS → results measured vs. the same number of days before (units, revenue, gross profit, margin, stock reduction) → kind statistics feed back into the ranking.

## Licensing
- Ed25519-signed keys (`SBM1.<payload>.<signature>`); the app contains only the public key.
- Machine code = hash of the OS machine id (Windows MachineGuid / Linux machine-id / macOS IOPlatformUUID).
- Trial (20 days) state is sealed (HMAC with a machine-derived key) and stored in three places: the user data folder, an OS-level mirror that survives uninstall (registry on Windows, hidden file in the home folder elsewhere) and the database. Earliest valid start wins; a single damaged copy heals; all copies invalid = tampering.
- Clock rollback beyond 6 hours (vs. the last time seen or the latest transaction in the database) blocks until the clock is fixed.
- When the trial/license ends, users can still log in, activate and back up their data.

## Backup
`.sbmbak` = magic line + JSON header (app id, schema version, app version, SHA-256, size) + gzip of an online SQLite snapshot. Restore validates checksum, gzip, `integrity_check`, app id and schema version, takes a safety backup of the current data, swaps the file atomically and rolls back on any failure.
