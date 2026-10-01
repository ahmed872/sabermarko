import { z } from 'zod';

/** Input schemas shared by the main process (validation) and renderer (types). */

const id = z.number().int().positive();
const optId = id.nullable().optional();
const money = z.number().int().min(0); // minor units
const milli = z.number().int(); // signed milli quantity
const posMilli = z.number().int().positive();
const optText = z.string().trim().max(500).nullable().optional();
const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const productUnitInput = z.object({
  unitId: id,
  factor: posMilli,
  barcode: z.string().trim().max(64).nullable().optional(),
  sellPrice: money.nullable().optional(),
  isDefaultSale: z.boolean().optional(),
  isDefaultPurchase: z.boolean().optional(),
});

export const productInput = z.object({
  name: z.string().trim().min(1).max(200),
  shortName: optText,
  categoryId: optId,
  brandId: optId,
  brandName: optText,
  groupName: optText,
  variantName: optText,
  baseUnitId: id,
  sku: z.string().trim().max(64).nullable().optional(),
  barcode: z.string().trim().max(64).nullable().optional(),
  sellPrice: money,
  cost: z.number().min(0).optional(), // per base unit, minor (may be fractional)
  minStock: z.number().int().min(0).default(0),
  reorderQty: z.number().int().min(0).nullable().optional(),
  isWeighted: z.boolean().default(false),
  trackExpiry: z.boolean().default(false),
  taxRate: z.number().min(0).max(100).nullable().optional(),
  defaultSupplierId: optId,
  isFavorite: z.boolean().default(false),
  allowDiscount: z.boolean().default(true),
  image: z.string().max(2_000_000).nullable().optional(),
  notes: optText,
  active: z.boolean().default(true),
  units: z.array(productUnitInput).max(20).default([]),
  prices: z.array(z.object({ priceListId: id, price: money })).max(20).default([]),
  openingStock: z
    .object({
      qty: posMilli,
      unitCost: z.number().min(0).optional(),
      expiryDate: dateStr.nullable().optional(),
      batchNo: optText,
      locationId: optId,
    })
    .nullable()
    .optional(),
});
export type ProductInput = z.input<typeof productInput>;

export const discountInput = z.object({
  type: z.enum(['amount', 'percent']),
  value: z.number().min(0), // amount: minor units; percent: 0..100
});
export type DiscountInput = z.infer<typeof discountInput>;

export const cartLineInput = z.object({
  key: z.string().max(64).optional(),
  productId: id,
  unitId: id,
  qty: posMilli, // milli of the chosen unit
  unitPrice: money.nullable().optional(), // manual override (per unit)
  discount: discountInput.nullable().optional(),
});
export type CartLineInput = z.infer<typeof cartLineInput>;

export const cartInput = z.object({
  customerId: optId,
  priceListId: optId,
  lines: z.array(cartLineInput).max(500),
  invoiceDiscount: discountInput.nullable().optional(),
});
export type CartInput = z.infer<typeof cartInput>;

export const paymentMethod = z.enum(['cash', 'card', 'wallet', 'credit']);
export type PaymentMethod = z.infer<typeof paymentMethod>;

export const checkoutInput = z.object({
  cart: cartInput,
  payments: z.array(z.object({ method: paymentMethod, amount: money })).max(5),
  note: optText,
  heldId: optId,
  quotationId: optId,
  /** client-generated idempotency key to prevent duplicate submission */
  clientRef: z.string().max(64).optional(),
});
export type CheckoutInput = z.infer<typeof checkoutInput>;

export const returnInput = z.object({
  saleId: id,
  items: z.array(z.object({ saleItemId: id, qty: posMilli, restock: z.boolean().default(true) })).min(1),
  refundMethod: z.enum(['cash', 'card', 'wallet', 'credit']),
  reason: optText,
});
export type ReturnInput = z.input<typeof returnInput>;

export const purchaseLineInput = z.object({
  productId: id,
  unitId: id,
  qty: posMilli,
  unitCost: money, // per purchased unit
  discount: money.default(0),
  batchNo: optText,
  expiryDate: dateStr.nullable().optional(),
  poItemId: optId,
  newSellPrice: money.nullable().optional(), // optionally update base sell price
});

export const purchaseInput = z.object({
  supplierId: optId,
  supplierInvoiceNo: optText,
  purchaseDate: dateStr.optional(),
  locationId: optId,
  lines: z.array(purchaseLineInput).min(1).max(1000),
  discount: money.default(0),
  tax: money.default(0),
  paid: money.default(0),
  paymentMethod: z.enum(['cash', 'card', 'wallet', 'bank']).default('cash'),
  paidFromDrawer: z.boolean().default(false),
  notes: optText,
  poId: optId,
});
export type PurchaseInput = z.input<typeof purchaseInput>;

export const purchaseReturnInput = z.object({
  purchaseId: optId,
  supplierId: optId,
  locationId: optId,
  lines: z
    .array(z.object({ purchaseItemId: optId, batchId: optId, productId: id, unitId: id, qty: posMilli, unitCost: money.default(0) }))
    .min(1),
  refundMethod: z.enum(['balance', 'cash']),
  reason: optText,
});
export type PurchaseReturnInput = z.input<typeof purchaseReturnInput>;

export const purchaseOrderInput = z.object({
  supplierId: id,
  locationId: optId,
  expectedDate: dateStr.nullable().optional(),
  notes: optText,
  lines: z.array(z.object({ productId: id, unitId: id, qty: posMilli, unitCost: money.default(0) })).min(1),
});
export type PurchaseOrderInput = z.input<typeof purchaseOrderInput>;

export const adjustmentInput = z.object({
  type: z.enum(['damage', 'loss', 'adjustment', 'opening']),
  locationId: optId,
  reason: optText,
  lines: z
    .array(
      z.object({
        productId: id,
        qty: milli, // signed for 'adjustment', positive for others
        unitCost: z.number().min(0).optional(),
        expiryDate: dateStr.nullable().optional(),
        batchNo: optText,
      }),
    )
    .min(1),
});
export type AdjustmentInput = z.input<typeof adjustmentInput>;

export const transferInput = z.object({
  fromLocationId: id,
  toLocationId: id,
  reason: optText,
  lines: z.array(z.object({ productId: id, qty: posMilli })).min(1),
});

export const partyInput = z.object({
  name: z.string().trim().min(1).max(200),
  phone: optText,
  address: optText,
  notes: optText,
  company: optText,
  leadTimeDays: z.number().int().min(0).max(365).nullable().optional(),
  creditLimit: money.nullable().optional(),
  priceListId: optId,
  openingBalance: z.number().int().optional(),
  active: z.boolean().default(true),
});
export type PartyInput = z.input<typeof partyInput>;

export const paymentInput = z.object({
  partyId: id,
  amount: z.number().int().positive(),
  method: z.enum(['cash', 'card', 'wallet', 'bank']).default('cash'),
  fromDrawer: z.boolean().default(true),
  note: optText,
});

export const expenseInput = z.object({
  categoryId: id,
  amount: z.number().int().positive(),
  note: optText,
  paidFromDrawer: z.boolean().default(false),
  businessDate: dateStr.optional(),
});

export const promotionInput = z.object({
  name: z.string().trim().min(1).max(200),
  type: z.enum(['percent', 'amount', 'bundle', 'bxgy', 'cross', 'combo']),
  rewardProductId: optId,
  rewardQty: z.number().int().min(0).optional(),
  rewardType: z.enum(['free', 'percent']).nullable().optional(),
  maxPerInvoice: z.number().int().positive().nullable().optional(),
  productId: optId,
  categoryId: optId,
  minQty: posMilli.default(1000),
  getQty: z.number().int().min(0).default(0),
  value: z.number().int().min(0),
  startDate: dateStr.nullable().optional(),
  endDate: dateStr.nullable().optional(),
  active: z.boolean().default(true),
});
export type PromotionInput = z.input<typeof promotionInput>;

export const userInput = z.object({
  username: z.string().trim().min(2).max(50),
  fullName: z.string().trim().min(1).max(100),
  password: z.string().min(4).max(200).optional(),
  roleId: id,
  maxDiscountPct: z.number().min(0).max(100).nullable().optional(),
  active: z.boolean().default(true),
});

export const roleInput = z.object({
  name: z.string().trim().min(1).max(100),
  permissions: z.array(z.string()).max(200),
});

export const setupInput = z.object({
  storeName: z.string().trim().min(1).max(200),
  phone: optText,
  address: optText,
  logo: z.string().max(2_000_000).nullable().optional(),
  currencyCode: z.string().min(3).max(3),
  currencySymbol: z.string().min(1).max(10),
  adminName: z.string().trim().min(1).max(100),
  adminUsername: z.string().trim().min(2).max(50),
  adminPassword: z.string().min(4).max(200),
  starterCategories: z.boolean().default(true),
  mode: z.enum(['simple', 'advanced']).default('simple'),
  printType: z.enum(['thermal80', 'thermal58', 'a4']).default('thermal80'),
});
export type SetupInput = z.input<typeof setupInput>;

export const dateRange = z.object({ from: dateStr, to: dateStr });
export type DateRange = z.infer<typeof dateRange>;
