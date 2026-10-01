export interface StoreSettings {
  'store.name': string;
  'store.phone': string;
  'store.address': string;
  'store.logo': string; // data URL (optional)
  'store.taxNumber': string;
  'store.receiptFooter': string;
  'currency.code': string;
  'currency.symbol': string;
  'ui.digits': 'latn' | 'arab';
  'ui.fontScale': number; // 1 = 100%
  /** simple | advanced : advanced reveals batches, locations, POs, price lists... */
  'mode': 'simple' | 'advanced';
  'features.multiLocation': boolean;
  'features.expiry': boolean;
  'features.purchaseOrders': boolean;
  'features.priceLists': boolean;
  'features.promotions': boolean;
  'features.quotations': boolean;
  'features.creditSales': boolean;
  'features.tax': boolean;
  'sales.allowNegativeStock': boolean;
  'sales.requireShift': boolean;
  'sales.allowReturns': boolean;
  'sales.returnDays': number;
  'sales.maxDiscountPct': number; // cashier discount threshold without approval
  'sales.invoicePrefix': string;
  'sales.roundTo': number; // minor units (0 = no rounding)
  'sales.scaleBarcode.enabled': boolean;
  'sales.scaleBarcode.prefix': string;
  'sales.scaleBarcode.codeLength': number;
  'sales.scaleBarcode.mode': 'weight' | 'price';
  'tax.rate': number; // percent
  'tax.inclusive': boolean;
  'inventory.lowStockDefault': number;
  'inventory.expiryAlertDays': number; // "near" tier
  'inventory.expiryCriticalDays': number; // "very near" tier
  'inventory.expiryWatchDays': number; // "follow-up" tier
  'inventory.deadStockDays': number;
  'inventory.reorderCoverDays': number;
  'print.type': 'thermal80' | 'thermal58' | 'a4';
  'print.printerName': string;
  'print.autoPrint': boolean;
  'print.copies': number;
  'print.showLogo': boolean;
  'backup.auto': boolean;
  'backup.onDayClose': boolean;
  'backup.frequencyHours': number;
  'backup.keep': number;
  'backup.directory': string;
  'backup.lastAt': string;
  'shift.maxHours': number;
  /** smart retail intelligence thresholds (all adjustable) */
  'intel.windowDays': number;
  'intel.minAgeDays': number;
  'intel.hotPercentile': number;
  'intel.slowPercentile': number;
  'intel.excessCoverDays': number;
  'intel.deadMultiplier': number;
  'intel.minMarginPct': number;
  'intel.maxDiscountPct': number;
  'intel.basketMinInvoices': number;
  'intel.basketMinPair': number;
  'intel.maxSuggestions': number;
  'onboarding.done': boolean;
}

export const DEFAULT_SETTINGS: StoreSettings = {
  'store.name': '',
  'store.phone': '',
  'store.address': '',
  'store.logo': '',
  'store.taxNumber': '',
  'store.receiptFooter': 'شكرًا لزيارتكم',
  'currency.code': 'EGP',
  'currency.symbol': 'ج.م',
  'ui.digits': 'latn',
  'ui.fontScale': 1,
  'mode': 'simple',
  'features.multiLocation': false,
  'features.expiry': false,
  'features.purchaseOrders': false,
  'features.priceLists': false,
  'features.promotions': false,
  'features.quotations': false,
  'features.creditSales': true,
  'features.tax': false,
  'sales.allowNegativeStock': true,
  'sales.requireShift': true,
  'sales.allowReturns': true,
  'sales.returnDays': 14,
  'sales.maxDiscountPct': 10,
  'sales.invoicePrefix': '',
  'sales.roundTo': 0,
  'sales.scaleBarcode.enabled': false,
  'sales.scaleBarcode.prefix': '2',
  'sales.scaleBarcode.codeLength': 5,
  'sales.scaleBarcode.mode': 'weight',
  'tax.rate': 14,
  'tax.inclusive': true,
  'inventory.lowStockDefault': 0,
  'inventory.expiryAlertDays': 30,
  'inventory.expiryCriticalDays': 7,
  'inventory.expiryWatchDays': 90,
  'inventory.deadStockDays': 30,
  'inventory.reorderCoverDays': 7,
  'print.type': 'thermal80',
  'print.printerName': '',
  'print.autoPrint': false,
  'print.copies': 1,
  'print.showLogo': true,
  'backup.auto': true,
  'backup.onDayClose': true,
  'backup.frequencyHours': 24,
  'backup.keep': 30,
  'backup.directory': '',
  'backup.lastAt': '',
  'shift.maxHours': 14,
  'intel.windowDays': 30,
  'intel.minAgeDays': 14,
  'intel.hotPercentile': 80,
  'intel.slowPercentile': 25,
  'intel.excessCoverDays': 60,
  'intel.deadMultiplier': 3,
  'intel.minMarginPct': 8,
  'intel.maxDiscountPct': 30,
  'intel.basketMinInvoices': 30,
  'intel.basketMinPair': 5,
  'intel.maxSuggestions': 5,
  'onboarding.done': false,
};

export type SettingKey = keyof StoreSettings;

export const CURRENCIES = [
  { code: 'EGP', symbol: 'ج.م', name: 'جنيه مصري' },
  { code: 'SAR', symbol: 'ر.س', name: 'ريال سعودي' },
  { code: 'AED', symbol: 'د.إ', name: 'درهم إماراتي' },
  { code: 'QAR', symbol: 'ر.ق', name: 'ريال قطري' },
  { code: 'USD', symbol: '$', name: 'دولار أمريكي' },
];

/** Keys that may be changed only by users with settings.manage. Everything is, here. */
export const PUBLIC_SETTING_KEYS: SettingKey[] = Object.keys(DEFAULT_SETTINGS) as SettingKey[];
