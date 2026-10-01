export const PERMISSIONS = {
  'pos.sell': 'البيع من نقطة البيع',
  'pos.price_override': 'تعديل سعر البيع داخل الفاتورة',
  'pos.discount': 'عمل خصم في حدود المسموح',
  'pos.discount_large': 'خصم أكبر من الحد المسموح',
  'pos.credit_sale': 'البيع الآجل',
  'pos.void': 'إلغاء فاتورة',
  'pos.return': 'عمل مرتجع بيع',
  'pos.open_drawer': 'فتح درج النقدية بدون بيع',
  'pos.negative_stock': 'البيع بدون رصيد كافٍ',
  'sales.view': 'عرض الفواتير',
  'sales.view_all': 'عرض فواتير كل الكاشير',
  'quotations.manage': 'عروض الأسعار',
  'products.view': 'عرض المنتجات',
  'products.manage': 'إضافة وتعديل المنتجات',
  'products.edit_price': 'تعديل أسعار البيع',
  'products.edit_cost': 'تعديل أسعار الشراء والتكلفة',
  'products.delete': 'حذف/إيقاف المنتجات',
  'inventory.view': 'عرض المخزون',
  'inventory.adjust': 'تعديل المخزون (تلف/فقد/تسوية)',
  'inventory.stocktake': 'الجرد',
  'inventory.transfer': 'تحويل بين الأماكن',
  'purchases.view': 'عرض المشتريات',
  'purchases.manage': 'تسجيل المشتريات والمرتجعات',
  'purchase_orders.manage': 'طلبات الشراء',
  'suppliers.manage': 'الموردون',
  'suppliers.pay': 'سداد الموردين',
  'customers.manage': 'العملاء',
  'customers.collect': 'تحصيل من العملاء',
  'customers.adjust_balance': 'تعديل رصيد عميل/مورد',
  'expenses.manage': 'المصروفات',
  'cash.manage': 'سحب وإيداع نقدية في الدرج',
  'shifts.close_others': 'إغلاق وردية كاشير آخر',
  'shifts.view_all': 'عرض كل الورديات',
  'promotions.approve': 'اعتماد العروض المقترحة',
  'promotions.override': 'اعتماد عرض رغم تحذير الربحية',
  'reports.view': 'التقارير والأرباح',
  'reports.cost': 'رؤية التكلفة والأرباح',
  'day.close': 'إغلاق اليوم',
  'users.manage': 'إدارة المستخدمين والصلاحيات',
  'settings.manage': 'الإعدادات',
  'backup.manage': 'النسخ الاحتياطي والاستعادة',
  'audit.view': 'سجل العمليات',
  'license.manage': 'التفعيل والترخيص',
} as const;

export type Permission = keyof typeof PERMISSIONS;
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as Permission[];

export const PERMISSION_GROUPS: { label: string; keys: Permission[] }[] = [
  { label: 'نقطة البيع', keys: ['pos.sell', 'pos.price_override', 'pos.discount', 'pos.discount_large', 'pos.credit_sale', 'pos.void', 'pos.return', 'pos.open_drawer', 'pos.negative_stock', 'sales.view', 'sales.view_all', 'quotations.manage'] },
  { label: 'المنتجات والمخزون', keys: ['products.view', 'products.manage', 'products.edit_price', 'products.edit_cost', 'products.delete', 'inventory.view', 'inventory.adjust', 'inventory.stocktake', 'inventory.transfer'] },
  { label: 'المشتريات والموردون', keys: ['purchases.view', 'purchases.manage', 'purchase_orders.manage', 'suppliers.manage', 'suppliers.pay'] },
  { label: 'العملاء والمالية', keys: ['customers.manage', 'customers.collect', 'customers.adjust_balance', 'expenses.manage', 'cash.manage', 'shifts.close_others', 'shifts.view_all', 'day.close'] },
  { label: 'الإدارة', keys: ['promotions.approve', 'promotions.override', 'reports.view', 'reports.cost', 'users.manage', 'settings.manage', 'backup.manage', 'audit.view', 'license.manage'] },
];

export interface RoleTemplate { code: string; name: string; permissions: Permission[] | '*' }

export const SYSTEM_ROLES: RoleTemplate[] = [
  { code: 'admin', name: 'المالك / المدير العام', permissions: '*' },
  {
    code: 'manager', name: 'مدير',
    permissions: ALL_PERMISSIONS.filter((p) => !['users.manage', 'license.manage', 'settings.manage'].includes(p)),
  },
  {
    code: 'cashier', name: 'كاشير',
    permissions: ['pos.sell', 'pos.discount', 'sales.view', 'products.view', 'inventory.view', 'customers.manage', 'customers.collect'],
  },
  {
    code: 'inventory', name: 'أمين مخزن',
    permissions: ['products.view', 'products.manage', 'inventory.view', 'inventory.adjust', 'inventory.stocktake', 'inventory.transfer', 'purchases.view', 'purchases.manage', 'purchase_orders.manage', 'suppliers.manage'],
  },
  {
    code: 'accountant', name: 'محاسب / تقارير',
    permissions: ['sales.view', 'sales.view_all', 'products.view', 'inventory.view', 'purchases.view', 'reports.view', 'reports.cost', 'shifts.view_all', 'expenses.manage', 'audit.view'],
  },
];

export function hasPermission(perms: Permission[] | '*', p: Permission): boolean {
  return perms === '*' || perms.includes(p);
}
