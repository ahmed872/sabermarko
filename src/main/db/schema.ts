/**
 * Database migrations. Each migration runs inside a transaction and bumps
 * PRAGMA user_version. Never edit a released migration — append a new one.
 *
 * Conventions:
 *  - money: INTEGER minor units (piasters)
 *  - quantity: INTEGER milli of the product's base unit (1 piece = 1000, 0.25kg = 250)
 *  - timestamps: TEXT local time 'YYYY-MM-DDTHH:MM:SS'
 *  - business_date: TEXT 'YYYY-MM-DD' (local day the operation belongs to)
 */
export const MIGRATIONS: string[] = [
  /* ---------------------------------------------------------------- v1 */
  `
  CREATE TABLE app_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE sequences (name TEXT PRIMARY KEY, next_value INTEGER NOT NULL DEFAULT 1);

  CREATE TABLE stores (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE locations (
    id INTEGER PRIMARY KEY,
    store_id INTEGER NOT NULL REFERENCES stores(id),
    name TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'shop' CHECK (type IN ('shop','warehouse','fridge','shelf','branch','other')),
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    UNIQUE (store_id, name)
  );

  CREATE TABLE roles (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    permissions TEXT NOT NULL,
    is_system INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    full_name TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    role_id INTEGER NOT NULL REFERENCES roles(id),
    max_discount_pct REAL,
    active INTEGER NOT NULL DEFAULT 1,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT
  );

  CREATE TABLE units (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'count' CHECK (kind IN ('count','weight','volume')),
    allow_decimal INTEGER NOT NULL DEFAULT 0,
    is_system INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    parent_id INTEGER REFERENCES categories(id),
    color TEXT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE brands (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE product_groups (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE price_lists (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    is_default INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    company TEXT,
    phone TEXT,
    address TEXT,
    notes TEXT,
    lead_time_days INTEGER,
    balance INTEGER NOT NULL DEFAULT 0, -- what the store owes the supplier (cache of ledger)
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE customers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    phone TEXT,
    address TEXT,
    notes TEXT,
    credit_limit INTEGER, -- NULL = no limit
    price_list_id INTEGER REFERENCES price_lists(id),
    balance INTEGER NOT NULL DEFAULT 0, -- what the customer owes the store (cache of ledger)
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE products (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    short_name TEXT,
    search_text TEXT NOT NULL DEFAULT '',
    category_id INTEGER REFERENCES categories(id),
    brand_id INTEGER REFERENCES brands(id),
    group_id INTEGER REFERENCES product_groups(id),
    variant_name TEXT,
    base_unit_id INTEGER NOT NULL REFERENCES units(id),
    sku TEXT UNIQUE,
    barcode TEXT UNIQUE,
    sell_price INTEGER NOT NULL DEFAULT 0 CHECK (sell_price >= 0), -- per base unit
    avg_cost REAL NOT NULL DEFAULT 0,    -- weighted average cost per base unit (minor)
    last_cost REAL NOT NULL DEFAULT 0,   -- last purchase cost per base unit (minor)
    min_stock INTEGER NOT NULL DEFAULT 0,
    reorder_qty INTEGER,
    is_weighted INTEGER NOT NULL DEFAULT 0,
    track_expiry INTEGER NOT NULL DEFAULT 0,
    tax_rate REAL, -- NULL = store default
    default_supplier_id INTEGER REFERENCES suppliers(id),
    is_favorite INTEGER NOT NULL DEFAULT 0,
    favorite_order INTEGER NOT NULL DEFAULT 0,
    allow_discount INTEGER NOT NULL DEFAULT 1,
    image TEXT,
    notes TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX idx_products_search ON products(search_text);
  CREATE INDEX idx_products_category ON products(category_id, active);
  CREATE INDEX idx_products_group ON products(group_id);
  CREATE INDEX idx_products_fav ON products(is_favorite, favorite_order);

  CREATE TABLE product_units (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    unit_id INTEGER NOT NULL REFERENCES units(id),
    factor INTEGER NOT NULL CHECK (factor > 0), -- milli of base unit contained in 1 of this unit
    barcode TEXT UNIQUE,
    sell_price INTEGER CHECK (sell_price IS NULL OR sell_price >= 0), -- NULL = base price x factor
    is_default_sale INTEGER NOT NULL DEFAULT 0,
    is_default_purchase INTEGER NOT NULL DEFAULT 0,
    UNIQUE (product_id, unit_id)
  );

  CREATE TABLE product_prices (
    product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
    price_list_id INTEGER NOT NULL REFERENCES price_lists(id),
    price INTEGER NOT NULL CHECK (price >= 0), -- per base unit
    PRIMARY KEY (product_id, price_list_id)
  );

  CREATE TABLE product_stock (
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    qty INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (product_id, location_id)
  );

  CREATE TABLE batches (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    batch_no TEXT,
    expiry_date TEXT,
    qty INTEGER NOT NULL DEFAULT 0,
    initial_qty INTEGER NOT NULL DEFAULT 0,
    unit_cost REAL NOT NULL DEFAULT 0,
    received_at TEXT NOT NULL,
    ref_type TEXT,
    ref_id INTEGER
  );
  CREATE INDEX idx_batches_product ON batches(product_id, location_id, expiry_date);
  CREATE INDEX idx_batches_expiry ON batches(expiry_date) WHERE qty > 0;

  CREATE TABLE stock_movements (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    type TEXT NOT NULL CHECK (type IN ('opening','purchase','sale','sale_return','purchase_return','stocktake','damage','loss','adjustment','transfer_in','transfer_out','void')),
    qty INTEGER NOT NULL,          -- signed, base milli
    qty_before INTEGER NOT NULL,
    qty_after INTEGER NOT NULL,
    unit_cost REAL NOT NULL DEFAULT 0, -- cost per base unit at movement time
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_movements_product ON stock_movements(product_id, id);
  CREATE INDEX idx_movements_date ON stock_movements(business_date, type);
  CREATE INDEX idx_movements_ref ON stock_movements(ref_type, ref_id);

  CREATE TABLE price_history (
    id INTEGER PRIMARY KEY,
    product_id INTEGER NOT NULL REFERENCES products(id),
    kind TEXT NOT NULL CHECK (kind IN ('sell','cost')),
    old_price REAL,
    new_price REAL NOT NULL,
    supplier_id INTEGER REFERENCES suppliers(id),
    ref_type TEXT,
    ref_id INTEGER,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_price_history ON price_history(product_id, kind, id);

  CREATE TABLE inventory_docs (
    id INTEGER PRIMARY KEY,
    doc_no TEXT NOT NULL UNIQUE,
    type TEXT NOT NULL CHECK (type IN ('opening','damage','loss','adjustment','transfer','stocktake')),
    from_location_id INTEGER REFERENCES locations(id),
    to_location_id INTEGER REFERENCES locations(id),
    reason TEXT,
    user_id INTEGER REFERENCES users(id),
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE stocktakes (
    id INTEGER PRIMARY KEY,
    doc_no TEXT NOT NULL UNIQUE,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','completed','cancelled')),
    scope TEXT NOT NULL DEFAULT 'all',
    category_id INTEGER REFERENCES categories(id),
    notes TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    completed_by INTEGER REFERENCES users(id),
    completed_at TEXT,
    inventory_doc_id INTEGER REFERENCES inventory_docs(id)
  );

  CREATE TABLE stocktake_items (
    stocktake_id INTEGER NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    system_qty INTEGER NOT NULL,
    counted_qty INTEGER,
    unit_cost REAL NOT NULL DEFAULT 0,
    PRIMARY KEY (stocktake_id, product_id)
  );

  CREATE TABLE shifts (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    terminal TEXT NOT NULL DEFAULT 'الكاشير 1',
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    opening_cash INTEGER NOT NULL DEFAULT 0,
    expected_cash INTEGER,
    counted_cash INTEGER,
    variance INTEGER,
    opened_at TEXT NOT NULL,
    closed_at TEXT,
    closed_by INTEGER REFERENCES users(id),
    close_note TEXT
  );
  CREATE INDEX idx_shifts_user ON shifts(user_id, status);

  CREATE TABLE cash_movements (
    id INTEGER PRIMARY KEY,
    shift_id INTEGER NOT NULL REFERENCES shifts(id),
    type TEXT NOT NULL CHECK (type IN ('opening','sale','refund','expense','withdrawal','deposit','customer_payment','supplier_payment','void','purchase')),
    amount INTEGER NOT NULL, -- signed: + into drawer, - out of drawer
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_cash_shift ON cash_movements(shift_id);

  CREATE TABLE sales (
    id INTEGER PRIMARY KEY,
    invoice_no TEXT NOT NULL UNIQUE,
    shift_id INTEGER REFERENCES shifts(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    customer_id INTEGER REFERENCES customers(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    price_list_id INTEGER REFERENCES price_lists(id),
    status TEXT NOT NULL DEFAULT 'completed' CHECK (status IN ('completed','voided')),
    subtotal INTEGER NOT NULL,        -- sum of gross line amounts
    line_discount INTEGER NOT NULL DEFAULT 0, -- manual + promo line discounts
    invoice_discount INTEGER NOT NULL DEFAULT 0,
    rounding INTEGER NOT NULL DEFAULT 0,
    tax_total INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,           -- amount due from customer
    net_revenue INTEGER NOT NULL,     -- total excluding tax (used for profit)
    paid INTEGER NOT NULL DEFAULT 0,  -- tendered by non-credit methods
    change_due INTEGER NOT NULL DEFAULT 0,
    credit_amount INTEGER NOT NULL DEFAULT 0,
    cogs INTEGER NOT NULL DEFAULT 0,
    items_count INTEGER NOT NULL DEFAULT 0,
    discount_by INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    quotation_id INTEGER,
    client_ref TEXT UNIQUE,
    note TEXT,
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    voided_at TEXT,
    voided_by INTEGER REFERENCES users(id),
    void_reason TEXT
  );
  CREATE INDEX idx_sales_date ON sales(business_date, status);
  CREATE INDEX idx_sales_shift ON sales(shift_id);
  CREATE INDEX idx_sales_customer ON sales(customer_id);
  CREATE INDEX idx_sales_user ON sales(user_id, business_date);

  CREATE TABLE sale_items (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    product_name TEXT NOT NULL,
    unit_name TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),   -- in sold unit, milli
    factor INTEGER NOT NULL,
    base_qty INTEGER NOT NULL CHECK (base_qty > 0),
    unit_price INTEGER NOT NULL,            -- per sold unit
    original_price INTEGER NOT NULL,        -- list price before manual override
    gross INTEGER NOT NULL,                 -- unit_price x qty
    discount INTEGER NOT NULL DEFAULT 0,    -- manual line discount
    promo_discount INTEGER NOT NULL DEFAULT 0,
    promotion_id INTEGER,
    invoice_discount_share INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    tax_rate REAL NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,                 -- amount charged for the line incl. tax, after all discounts
    net_revenue INTEGER NOT NULL,           -- total - tax (revenue recognised)
    unit_cost REAL NOT NULL,                -- avg cost per base unit at sale time
    cost_total INTEGER NOT NULL,
    returned_base_qty INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_sale_items_sale ON sale_items(sale_id);
  CREATE INDEX idx_sale_items_product ON sale_items(product_id);

  CREATE TABLE sale_item_batches (
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    qty INTEGER NOT NULL,
    PRIMARY KEY (sale_item_id, batch_id)
  );

  CREATE TABLE sale_payments (
    id INTEGER PRIMARY KEY,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    method TEXT NOT NULL CHECK (method IN ('cash','card','wallet','credit')),
    amount INTEGER NOT NULL
  );
  CREATE INDEX idx_sale_payments ON sale_payments(sale_id);

  CREATE TABLE sale_returns (
    id INTEGER PRIMARY KEY,
    return_no TEXT NOT NULL UNIQUE,
    sale_id INTEGER NOT NULL REFERENCES sales(id),
    shift_id INTEGER REFERENCES shifts(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    customer_id INTEGER REFERENCES customers(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    total INTEGER NOT NULL,         -- refunded to customer incl. tax
    net_revenue INTEGER NOT NULL,   -- revenue reversed (excl. tax)
    tax_total INTEGER NOT NULL DEFAULT 0,
    cogs INTEGER NOT NULL,
    refund_method TEXT NOT NULL CHECK (refund_method IN ('cash','card','wallet','credit')),
    reason TEXT,
    approved_by INTEGER REFERENCES users(id),
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_returns_date ON sale_returns(business_date);
  CREATE INDEX idx_returns_sale ON sale_returns(sale_id);

  CREATE TABLE sale_return_items (
    id INTEGER PRIMARY KEY,
    return_id INTEGER NOT NULL REFERENCES sale_returns(id),
    sale_item_id INTEGER NOT NULL REFERENCES sale_items(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    qty INTEGER NOT NULL,       -- in sold unit milli
    base_qty INTEGER NOT NULL,
    total INTEGER NOT NULL,
    net_revenue INTEGER NOT NULL,
    tax INTEGER NOT NULL DEFAULT 0,
    cost_total INTEGER NOT NULL,
    restock INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE held_sales (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    label TEXT,
    customer_id INTEGER REFERENCES customers(id),
    payload TEXT NOT NULL,
    total INTEGER NOT NULL DEFAULT 0,
    items_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );

  CREATE TABLE quotations (
    id INTEGER PRIMARY KEY,
    quote_no TEXT NOT NULL UNIQUE,
    customer_id INTEGER REFERENCES customers(id),
    customer_name TEXT,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','cancelled')),
    payload TEXT NOT NULL,
    total INTEGER NOT NULL,
    valid_until TEXT,
    note TEXT,
    sale_id INTEGER REFERENCES sales(id),
    created_at TEXT NOT NULL
  );

  CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY,
    po_no TEXT NOT NULL UNIQUE,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','partial','received','cancelled')),
    expected_date TEXT,
    total INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE purchase_order_items (
    id INTEGER PRIMARY KEY,
    po_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    factor INTEGER NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    received_qty INTEGER NOT NULL DEFAULT 0,
    unit_cost INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE purchases (
    id INTEGER PRIMARY KEY,
    purchase_no TEXT NOT NULL UNIQUE,
    supplier_id INTEGER REFERENCES suppliers(id),
    supplier_invoice_no TEXT,
    location_id INTEGER NOT NULL REFERENCES locations(id),
    po_id INTEGER REFERENCES purchase_orders(id),
    subtotal INTEGER NOT NULL,
    discount INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,
    paid INTEGER NOT NULL DEFAULT 0,
    paid_from_drawer INTEGER NOT NULL DEFAULT 0,
    notes TEXT,
    user_id INTEGER REFERENCES users(id),
    purchase_date TEXT NOT NULL,
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_purchases_supplier ON purchases(supplier_id);
  CREATE INDEX idx_purchases_date ON purchases(business_date);

  CREATE TABLE purchase_items (
    id INTEGER PRIMARY KEY,
    purchase_id INTEGER NOT NULL REFERENCES purchases(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    product_name TEXT NOT NULL,
    unit_name TEXT NOT NULL,
    qty INTEGER NOT NULL CHECK (qty > 0),
    factor INTEGER NOT NULL,
    base_qty INTEGER NOT NULL,
    unit_cost INTEGER NOT NULL,   -- per purchased unit
    discount INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL,       -- after line discount
    landed_total INTEGER NOT NULL,-- after invoice discount allocation (used for costing)
    batch_id INTEGER REFERENCES batches(id),
    batch_no TEXT,
    expiry_date TEXT,
    returned_base_qty INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX idx_purchase_items_product ON purchase_items(product_id);

  CREATE TABLE purchase_returns (
    id INTEGER PRIMARY KEY,
    return_no TEXT NOT NULL UNIQUE,
    purchase_id INTEGER REFERENCES purchases(id),
    supplier_id INTEGER REFERENCES suppliers(id),
    location_id INTEGER NOT NULL REFERENCES locations(id),
    total INTEGER NOT NULL,
    refund_method TEXT NOT NULL CHECK (refund_method IN ('balance','cash')),
    reason TEXT,
    user_id INTEGER REFERENCES users(id),
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE purchase_return_items (
    id INTEGER PRIMARY KEY,
    return_id INTEGER NOT NULL REFERENCES purchase_returns(id),
    purchase_item_id INTEGER REFERENCES purchase_items(id),
    product_id INTEGER NOT NULL REFERENCES products(id),
    unit_id INTEGER NOT NULL REFERENCES units(id),
    qty INTEGER NOT NULL,
    base_qty INTEGER NOT NULL,
    unit_cost INTEGER NOT NULL,
    total INTEGER NOT NULL,
    cost_total INTEGER NOT NULL
  );

  CREATE TABLE party_payments (
    id INTEGER PRIMARY KEY,
    payment_no TEXT NOT NULL UNIQUE,
    party_type TEXT NOT NULL CHECK (party_type IN ('customer','supplier')),
    party_id INTEGER NOT NULL,
    amount INTEGER NOT NULL CHECK (amount > 0),
    method TEXT NOT NULL CHECK (method IN ('cash','card','wallet','bank')),
    shift_id INTEGER REFERENCES shifts(id),
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE customer_ledger (
    id INTEGER PRIMARY KEY,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    type TEXT NOT NULL CHECK (type IN ('opening','sale','payment','return','void','adjustment')),
    amount INTEGER NOT NULL, -- + increases customer debt
    balance_after INTEGER NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_customer_ledger ON customer_ledger(customer_id, id);

  CREATE TABLE supplier_ledger (
    id INTEGER PRIMARY KEY,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    type TEXT NOT NULL CHECK (type IN ('opening','purchase','payment','return','adjustment')),
    amount INTEGER NOT NULL, -- + increases what the store owes
    balance_after INTEGER NOT NULL,
    ref_type TEXT,
    ref_id INTEGER,
    note TEXT,
    user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_supplier_ledger ON supplier_ledger(supplier_id, id);

  CREATE TABLE expense_categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE expenses (
    id INTEGER PRIMARY KEY,
    category_id INTEGER NOT NULL REFERENCES expense_categories(id),
    amount INTEGER NOT NULL CHECK (amount > 0),
    note TEXT,
    paid_from_drawer INTEGER NOT NULL DEFAULT 0,
    shift_id INTEGER REFERENCES shifts(id),
    user_id INTEGER REFERENCES users(id),
    business_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    deleted_at TEXT,
    deleted_by INTEGER REFERENCES users(id)
  );
  CREATE INDEX idx_expenses_date ON expenses(business_date);

  CREATE TABLE promotions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('percent','amount','bundle','bxgy')),
    product_id INTEGER REFERENCES products(id),
    category_id INTEGER REFERENCES categories(id),
    min_qty INTEGER NOT NULL DEFAULT 1000,  -- milli base units (percent/amount); bundle size for 'bundle'; buy qty for 'bxgy'
    get_qty INTEGER NOT NULL DEFAULT 0,     -- free qty for bxgy (milli)
    value INTEGER NOT NULL DEFAULT 0,       -- percent x100 / amount per unit / bundle price
    start_date TEXT,
    end_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL
  );

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id),
    approved_by INTEGER REFERENCES users(id),
    action TEXT NOT NULL,
    entity TEXT,
    entity_id INTEGER,
    old_value TEXT,
    new_value TEXT,
    reason TEXT,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_audit_date ON audit_log(created_at);
  CREATE INDEX idx_audit_entity ON audit_log(entity, entity_id);

  CREATE TABLE day_closings (
    id INTEGER PRIMARY KEY,
    business_date TEXT NOT NULL UNIQUE,
    summary TEXT NOT NULL,
    closed_by INTEGER REFERENCES users(id),
    closed_at TEXT NOT NULL,
    backup_file TEXT
  );
  `,
  /* ---------------------------------------------------------------- v2: smart retail intelligence */
  `
  -- promotions gain cross-product rules (buy A -> reward on B, A+B combo price) and a link to the suggestion that created them
  CREATE TABLE promotions_v2 (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('percent','amount','bundle','bxgy','cross','combo')),
    product_id INTEGER REFERENCES products(id),
    category_id INTEGER REFERENCES categories(id),
    min_qty INTEGER NOT NULL DEFAULT 1000,
    get_qty INTEGER NOT NULL DEFAULT 0,
    value INTEGER NOT NULL DEFAULT 0,
    reward_product_id INTEGER REFERENCES products(id),
    reward_qty INTEGER NOT NULL DEFAULT 0,       -- milli base units of the reward product per deal
    reward_type TEXT CHECK (reward_type IS NULL OR reward_type IN ('free','percent')),
    max_per_invoice INTEGER,                     -- cap on deals per invoice (protects fast movers used as gifts)
    start_date TEXT,
    end_date TEXT,
    active INTEGER NOT NULL DEFAULT 1,
    suggestion_id INTEGER,
    reason TEXT,
    baseline TEXT,                               -- JSON snapshot of metrics before the promotion
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  INSERT INTO promotions_v2(id, name, type, product_id, category_id, min_qty, get_qty, value, start_date, end_date, active, created_at)
    SELECT id, name, type, product_id, category_id, min_qty, get_qty, value, start_date, end_date, active, created_at FROM promotions;
  DROP TABLE promotions;
  ALTER TABLE promotions_v2 RENAME TO promotions;
  CREATE INDEX idx_promotions_active ON promotions(active, start_date, end_date);

  CREATE TABLE promotion_suggestions (
    id INTEGER PRIMARY KEY,
    period TEXT NOT NULL,                        -- YYYY-MM the suggestion was generated for
    kind TEXT NOT NULL CHECK (kind IN ('clearance','pair','bundle','expiry','quantity')),
    status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','approved','rejected','dismissed','expired')),
    product_id INTEGER NOT NULL REFERENCES products(id),
    partner_product_id INTEGER REFERENCES products(id),
    score REAL NOT NULL DEFAULT 0,
    verdict TEXT NOT NULL DEFAULT 'ok' CHECK (verdict IN ('good','ok','review')),
    payload TEXT NOT NULL,                       -- proposal, simulation, reasons (JSON)
    generated_at TEXT NOT NULL,
    decided_by INTEGER REFERENCES users(id),
    decided_at TEXT,
    decision_note TEXT,
    promotion_id INTEGER REFERENCES promotions(id)
  );
  CREATE INDEX idx_suggestions_period ON promotion_suggestions(period, status);
  CREATE INDEX idx_suggestions_product ON promotion_suggestions(product_id, kind);

  CREATE TABLE suggestion_mutes (
    id INTEGER PRIMARY KEY,
    product_id INTEGER REFERENCES products(id),
    kind TEXT,
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_sale_items_promo ON sale_items(promotion_id) WHERE promotion_id IS NOT NULL;
  `,
  /* ---------------------------------------------------------------- v3: batch lineage + batch-aware supplier returns */
  `
  -- every received quantity is its own batch: who supplied it, from which purchase line, and (after a
  -- transfer) which batch it came from; supplier returns record the exact batch they took stock from
  ALTER TABLE batches ADD COLUMN supplier_id INTEGER REFERENCES suppliers(id);
  ALTER TABLE batches ADD COLUMN purchase_item_id INTEGER REFERENCES purchase_items(id);
  ALTER TABLE batches ADD COLUMN source_batch_id INTEGER REFERENCES batches(id);
  ALTER TABLE purchase_return_items ADD COLUMN batch_id INTEGER REFERENCES batches(id);
  UPDATE batches SET supplier_id = (SELECT p.supplier_id FROM purchases p WHERE p.id = batches.ref_id) WHERE ref_type = 'purchase';
  UPDATE batches SET purchase_item_id = (SELECT pi.id FROM purchase_items pi WHERE pi.batch_id = batches.id ORDER BY pi.id LIMIT 1) WHERE ref_type = 'purchase';
  CREATE INDEX idx_batches_supplier ON batches(supplier_id) WHERE supplier_id IS NOT NULL;
  `,
];
