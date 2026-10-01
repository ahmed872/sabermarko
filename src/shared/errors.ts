/**
 * User-facing error codes. The main process throws AppError(code, params);
 * the renderer only ever shows the Arabic message for the code.
 * Technical details go to the log file, never to the user.
 */
export const ERROR_MESSAGES = {
  UNKNOWN: 'حدث خطأ غير متوقع. تم تسجيل التفاصيل، حاول مرة أخرى.',
  VALIDATION: 'البيانات المدخلة غير صحيحة: {detail}',
  NOT_FOUND: 'العنصر المطلوب غير موجود.',
  NOT_AUTHENTICATED: 'يجب تسجيل الدخول أولًا.',
  FORBIDDEN: 'ليس لديك صلاحية لتنفيذ هذه العملية.',
  APPROVAL_REQUIRED: 'هذه العملية تحتاج موافقة مدير.',
  APPROVAL_INVALID: 'بيانات المدير غير صحيحة أو ليس لديه الصلاحية المطلوبة.',
  INVALID_CREDENTIALS: 'اسم المستخدم أو كلمة المرور غير صحيحة.',
  USER_INACTIVE: 'هذا المستخدم موقوف. تواصل مع المدير.',
  USERNAME_TAKEN: 'اسم المستخدم مستخدم بالفعل.',
  USER_LIMIT: 'وصلت للحد الأقصى لعدد المستخدمين النشطين في ترخيصك ({max} مستخدمين). أوقف مستخدمًا غير مستخدم أو قم بترقية الترخيص.',
  LAST_ADMIN: 'لا يمكن إيقاف أو تغيير صلاحية آخر مدير في النظام.',
  WEAK_PASSWORD: 'كلمة المرور يجب ألا تقل عن 4 أحرف.',
  DUPLICATE_BARCODE: 'الباركود "{barcode}" مستخدم لمنتج آخر.',
  DUPLICATE_SKU: 'الكود "{sku}" مستخدم لمنتج آخر.',
  DUPLICATE_NAME: 'الاسم "{name}" موجود بالفعل.',
  PRODUCT_INACTIVE: 'المنتج "{name}" موقوف ولا يمكن بيعه.',
  PRODUCT_IN_USE: 'لا يمكن حذف المنتج لأنه مستخدم في فواتير أو حركات سابقة. يمكنك إيقافه بدلًا من الحذف.',
  IN_USE: 'لا يمكن الحذف لأن العنصر مستخدم في بيانات أخرى. يمكنك إيقافه بدلًا من ذلك.',
  INSUFFICIENT_STOCK: 'الكمية المتاحة من "{name}" غير كافية (المتاح: {available}).',
  INVALID_QTY: 'الكمية غير صحيحة.',
  INVALID_PRICE: 'السعر غير صحيح.',
  INVALID_UNIT: 'الوحدة غير صحيحة لهذا المنتج.',
  DECIMAL_NOT_ALLOWED: 'المنتج "{name}" لا يُباع بكسور. أدخل عددًا صحيحًا.',
  EMPTY_CART: 'الفاتورة فارغة. أضف منتجًا واحدًا على الأقل.',
  PAYMENT_INSUFFICIENT: 'المبلغ المدفوع أقل من الإجمالي.',
  CUSTOMER_REQUIRED: 'البيع الآجل يحتاج اختيار عميل.',
  CREDIT_LIMIT: 'تجاوز حد الائتمان للعميل "{name}" (الحد: {limit}).',
  CREDIT_DISABLED: 'البيع الآجل غير مفعّل في الإعدادات.',
  DISCOUNT_TOO_LARGE: 'الخصم أكبر من الحد المسموح لك ({max}%).',
  DISCOUNT_EXCEEDS_TOTAL: 'الخصم أكبر من قيمة الفاتورة.',
  PRICE_BELOW_COST: 'سعر البيع أقل من التكلفة.',
  SHIFT_REQUIRED: 'يجب فتح وردية (درج النقدية) أولًا لإتمام هذه العملية.',
  SHIFT_ALREADY_OPEN: 'لديك وردية مفتوحة بالفعل.',
  SHIFT_NOT_OPEN: 'لا توجد وردية مفتوحة.',
  SHIFT_CLOSED: 'هذه الوردية مغلقة.',
  CASH_INSUFFICIENT: 'النقدية في الدرج لا تكفي لهذه العملية.',
  SALE_ALREADY_VOIDED: 'هذه الفاتورة ملغاة بالفعل.',
  VOID_NOT_TODAY: 'يمكن إلغاء فواتير اليوم فقط. للفواتير الأقدم استخدم المرتجع.',
  CHANGE_FROM_CARD: 'لا يمكن إرجاع باقي من دفع بالكارت أو المحفظة. الباقي يُصرف من النقدية فقط.',
  OVERPAID_NON_CASH: 'مبلغ الكارت/المحفظة أكبر من إجمالي الفاتورة.',
  SALE_HAS_RETURNS: 'لا يمكن إلغاء فاتورة عليها مرتجعات. استخدم المرتجع بدلًا من ذلك.',
  RETURN_QTY_EXCEEDED: 'كمية المرتجع من "{name}" أكبر من الكمية المتبقية في الفاتورة.',
  RETURNS_DISABLED: 'المرتجعات غير مفعّلة في الإعدادات.',
  RETURN_PERIOD_EXPIRED: 'انتهت المدة المسموح بها للمرتجع ({days} يوم).',
  NOTHING_TO_RETURN: 'لم يتم تحديد أي كمية للمرتجع.',
  PURCHASE_EMPTY: 'فاتورة الشراء فارغة.',
  PAID_EXCEEDS_TOTAL: 'المبلغ المدفوع أكبر من المستحق.',
  AMOUNT_INVALID: 'المبلغ غير صحيح.',
  PO_NOT_OPEN: 'طلب الشراء غير مفتوح.',
  STOCKTAKE_NOT_OPEN: 'الجرد غير مفتوح.',
  STOCKTAKE_ALREADY_OPEN: 'يوجد جرد مفتوح بالفعل لهذا المكان.',
  SAME_LOCATION: 'لا يمكن التحويل إلى نفس المكان.',
  DAY_ALREADY_CLOSED: 'تم إغلاق هذا اليوم بالفعل.',
  EXPIRY_REQUIRED: 'المنتج "{name}" يحتاج تاريخ صلاحية.',
  LICENSE_REQUIRED: 'انتهت الفترة التجريبية أو الترخيص. يرجى تفعيل البرنامج للمتابعة.',
  LICENSE_INVALID: 'كود التفعيل غير صحيح.',
  LICENSE_WRONG_MACHINE: 'كود التفعيل خاص بجهاز آخر.',
  LICENSE_EXPIRED: 'كود التفعيل منتهي الصلاحية.',
  CLOCK_TAMPERED: 'تاريخ ووقت الجهاز غير صحيح (يبدو أنه رجع للخلف). صحّح الوقت ثم أعد تشغيل البرنامج.',
  BACKUP_INVALID: 'ملف النسخة الاحتياطية غير صالح أو تالف.',
  BACKUP_NEWER: 'هذه النسخة الاحتياطية من إصدار أحدث من البرنامج. حدّث البرنامج أولًا.',
  BACKUP_FAILED: 'تعذر إنشاء النسخة الاحتياطية: تأكد من صلاحية الكتابة في المجلد.',
  RESTORE_FAILED: 'تعذرت استعادة النسخة. لم يتم تغيير بياناتك الحالية.',
  DB_BUSY: 'قاعدة البيانات مشغولة حاليًا. حاول بعد لحظات.',
  PRINT_FAILED: 'تعذرت الطباعة. تأكد من توصيل الطابعة واختيارها في الإعدادات.',
  ALREADY_SETUP: 'تم إعداد البرنامج من قبل.',
  PROMO_UNSAFE: 'هذا العرض يسبب خسارة أو يخفض هامش الربح أقل من الحد المسموح. يحتاج اعتماد مدير لديه صلاحية تجاوز التحذير.',
  SUGGESTION_CLOSED: 'تم اتخاذ قرار في هذا الاقتراح من قبل.',
  FEATURE_DISABLED: 'هذه الميزة غير مفعّلة. يمكن تفعيلها من الإعدادات.',
} as const;

export type ErrorCode = keyof typeof ERROR_MESSAGES;

export interface AppErrorPayload {
  code: ErrorCode;
  params?: Record<string, string | number>;
}

export class AppError extends Error {
  code: ErrorCode;
  params?: Record<string, string | number>;
  constructor(code: ErrorCode, params?: Record<string, string | number>) {
    super(code);
    this.code = code;
    this.params = params;
  }
}

export function errorMessage(code: string, params?: Record<string, string | number>): string {
  const tpl = (ERROR_MESSAGES as Record<string, string>)[code] ?? ERROR_MESSAGES.UNKNOWN;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (params && params[k] !== undefined ? String(params[k]) : ''));
}
