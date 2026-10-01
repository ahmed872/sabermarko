import type { Rng } from './rng';

/**
 * Synthetic but realistic Egyptian supermarket catalog. Each template expands
 * into many SKUs (brand x size/flavour). Every SKU gets a demand profile:
 * popularity (Zipf), seasonality, a trend (rising / falling / dying) and an
 * optional launch date, so the year contains hot, stable, slow, dead and new items.
 */
export type Season = 'none' | 'summer' | 'winter' | 'ramadan' | 'school';
export interface Template {
  category: string; supplier: string; brands: string[]; variants: string[];
  unit: 'قطعة' | 'علبة' | 'كيس' | 'زجاجة' | 'عبوة' | 'كيلو';
  price: [number, number]; margin: [number, number]; carton?: number[];
  weighted?: boolean; shelfLifeDays?: [number, number]; season?: Season; warehouse?: boolean; slow?: boolean;
}

export const SUPPLIERS = [
  { key: 'pepsico', name: 'بيبسيكو — التوزيع', lead: 2, visit: [0, 3], terms: 'credit' },
  { key: 'coca', name: 'كوكاكولا — الوكيل', lead: 2, visit: [1, 4], terms: 'credit' },
  { key: 'juhayna', name: 'جهينة للألبان', lead: 1, visit: [0, 2, 4, 6], terms: 'cash' },
  { key: 'almarai', name: 'المراعي', lead: 1, visit: [1, 3, 5], terms: 'cash' },
  { key: 'domty', name: 'دومتي', lead: 1, visit: [0, 3, 5], terms: 'credit' },
  { key: 'cadbury', name: 'موندليز مصر', lead: 3, visit: [2], terms: 'credit' },
  { key: 'edita', name: 'إيديتا', lead: 2, visit: [1, 5], terms: 'credit' },
  { key: 'frozen', name: 'كوكي للمجمدات', lead: 2, visit: [2, 6], terms: 'credit' },
  { key: 'canned', name: 'هارفست فودز', lead: 4, visit: [3], terms: 'credit' },
  { key: 'pg', name: 'بروكتر آند جامبل — موزع', lead: 5, visit: [0], terms: 'credit' },
  { key: 'unilever', name: 'يونيليفر — موزع', lead: 5, visit: [4], terms: 'credit' },
  { key: 'bulk', name: 'مخازن النور للجملة', lead: 1, visit: [6, 2], terms: 'cash' },
  { key: 'grocery', name: 'الضحى للمواد الغذائية', lead: 3, visit: [1], terms: 'credit' },
  { key: 'oil', name: 'عافية للزيوت', lead: 3, visit: [3], terms: 'credit' },
  { key: 'tea', name: 'العروسة للشاي', lead: 3, visit: [5], terms: 'credit' },
  { key: 'water', name: 'نستله ووترز', lead: 2, visit: [0, 4], terms: 'credit' },
  { key: 'bakery', name: 'مخبز الأمل', lead: 1, visit: [0, 1, 2, 3, 4, 5, 6], terms: 'cash' },
  { key: 'nuts', name: 'السوري للمكسرات', lead: 3, visit: [2], terms: 'cash' },
] as const;

export const TEMPLATES: Template[] = [
  { category: 'مشروبات', supplier: 'coca', brands: ['كوكاكولا', 'سبرايت', 'فانتا برتقال', 'شويبس'], variants: ['250 مل كانز', '330 مل', '1 لتر', '1.5 لتر', '2 لتر'], unit: 'زجاجة', price: [8, 40], margin: [0.12, 0.22], carton: [24, 12, 6], season: 'summer' },
  { category: 'مشروبات', supplier: 'pepsico', brands: ['بيبسي', 'ميرندا', 'سفن أب', 'ماونتن ديو'], variants: ['250 مل كانز', '330 مل', '1 لتر', '2 لتر'], unit: 'زجاجة', price: [8, 38], margin: [0.12, 0.22], carton: [24, 12, 6], season: 'summer' },
  { category: 'مشروبات', supplier: 'water', brands: ['مياه نستله', 'مياه أكوافينا', 'مياه دساني', 'مياه صافي'], variants: ['330 مل', '600 مل', '1.5 لتر', '6 لتر'], unit: 'زجاجة', price: [4, 25], margin: [0.15, 0.3], carton: [24, 12, 6], season: 'summer', warehouse: true },
  { category: 'مشروبات', supplier: 'juhayna', brands: ['عصير جهينة', 'عصير بيتي', 'عصير لمار'], variants: ['مانجو 235 مل', 'جوافة 235 مل', 'برتقال 1 لتر', 'تفاح 1 لتر', 'كوكتيل 1 لتر'], unit: 'علبة', price: [9, 45], margin: [0.14, 0.25], carton: [24, 12], shelfLifeDays: [90, 180], season: 'ramadan' },
  { category: 'مشروبات', supplier: 'bulk', brands: ['ريد بول', 'باور هورس', 'فيروز', 'بيريل'], variants: ['250 مل', '330 مل'], unit: 'زجاجة', price: [15, 45], margin: [0.15, 0.25], carton: [24], season: 'summer' },
  { category: 'شيبسي وسناكس', supplier: 'pepsico', brands: ['شيبسي', 'دوريتوس', 'لايز', 'كرانشي'], variants: ['طماطم صغير', 'جبنة صغير', 'ملح وخل', 'شطة وليمون', 'طماطم عائلي', 'جبنة عائلي', 'باربكيو عائلي'], unit: 'كيس', price: [5, 30], margin: [0.18, 0.3], carton: [30, 24, 12] },
  { category: 'شيبسي وسناكس', supplier: 'edita', brands: ['بيك رولز', 'تايجر', 'مولتو', 'تودو', 'هوهوز', 'توينكيز'], variants: ['صغير', 'وسط', 'كبير', 'عائلي', 'شوكولاتة', 'فراولة'], unit: 'قطعة', price: [5, 25], margin: [0.18, 0.3], carton: [24, 30, 12] },
  { category: 'حلويات وشوكولاتة', supplier: 'cadbury', brands: ['كادبوري ديري ميلك', 'جالاكسي', 'كيت كات', 'تويكس', 'سنيكرز', 'مارس', 'باونتي'], variants: ['صغير', 'وسط', 'كبير', 'بالبندق', 'بالكراميل'], unit: 'قطعة', price: [10, 90], margin: [0.15, 0.28], carton: [24, 48, 12], season: 'winter' },
  { category: 'حلويات وشوكولاتة', supplier: 'bulk', brands: ['نوتيلا', 'بسكويت أولكر', 'بسكويت بيمبو', 'شوكولاتة كورونا'], variants: ['200 جم', '350 جم', '750 جم', 'عرض'], unit: 'علبة', price: [20, 180], margin: [0.12, 0.25], carton: [12, 6], slow: true },
  { category: 'ألبان وأجبان', supplier: 'juhayna', brands: ['لبن جهينة', 'زبادي جهينة', 'رايب جهينة'], variants: ['كامل الدسم 1 لتر', 'خالي الدسم 1 لتر', '200 مل', '105 جم', 'فراولة'], unit: 'علبة', price: [6, 50], margin: [0.1, 0.18], carton: [12, 24], shelfLifeDays: [7, 20], season: 'ramadan' },
  { category: 'ألبان وأجبان', supplier: 'almarai', brands: ['لبن المراعي', 'زبادي المراعي', 'لبنة المراعي'], variants: ['1 لتر', '500 مل', '170 جم', '400 جم'], unit: 'علبة', price: [7, 60], margin: [0.1, 0.18], carton: [12, 24], shelfLifeDays: [7, 25] },
  { category: 'ألبان وأجبان', supplier: 'domty', brands: ['جبنة دومتي', 'جبنة بريزيدون', 'جبنة لافاش كيري', 'جبنة فيتا'], variants: ['250 جم', '500 جم', '8 مثلثات', '16 مثلث', 'لايت'], unit: 'علبة', price: [15, 120], margin: [0.12, 0.22], carton: [12, 24], shelfLifeDays: [30, 90], season: 'ramadan' },
  { category: 'ألبان وأجبان', supplier: 'domty', brands: ['جبنة رومي', 'جبنة بيضاء', 'جبنة شيدر', 'لانشون'], variants: ['بالوزن', 'قديمة بالوزن', 'مدخن بالوزن'], unit: 'كيلو', price: [120, 420], margin: [0.15, 0.25], weighted: true, shelfLifeDays: [20, 45], season: 'ramadan' },
  { category: 'مجمدات', supplier: 'frozen', brands: ['فراخ كوكي', 'ناجتس كوكي', 'برجر حلواني', 'سجق حلواني', 'بسلة مجمدة', 'خضار مشكل'], variants: ['400 جم', '1 كيلو', 'عائلي'], unit: 'كيس', price: [30, 260], margin: [0.1, 0.2], carton: [12, 6], shelfLifeDays: [120, 240] },
  { category: 'مجمدات', supplier: 'frozen', brands: ['آيس كريم كرنفال', 'آيس كريم نستله', 'آيس كريم مكسيكي'], variants: ['كون', 'بولة', 'عائلي 1 لتر', 'ستيك'], unit: 'قطعة', price: [8, 90], margin: [0.18, 0.3], carton: [24, 6], season: 'summer', shelfLifeDays: [150, 240] },
  { category: 'معلبات', supplier: 'canned', brands: ['تونة صن شاين', 'تونة دولفين', 'فول أمريكانا', 'صلصة هاينز', 'ذرة جرين جاينت', 'مشروم', 'سردين'], variants: ['صغير', 'كبير', 'قطع', 'مفتت', 'بالزيت'], unit: 'علبة', price: [12, 70], margin: [0.12, 0.22], carton: [24, 48], shelfLifeDays: [360, 720], season: 'ramadan' },
  { category: 'منظفات', supplier: 'pg', brands: ['أريال', 'تايد', 'فيري', 'داوني', 'ميستر بروبر'], variants: ['1 كيلو', '2.5 كيلو', '4 كيلو', '750 مل', '1.5 لتر', 'جل'], unit: 'عبوة', price: [25, 320], margin: [0.1, 0.18], carton: [6, 12], slow: true, warehouse: true },
  { category: 'منظفات', supplier: 'unilever', brands: ['برسيل', 'أومو', 'كلوركس', 'دوف سائل', 'ديتول'], variants: ['1 كيلو', '2.5 كيلو', '1 لتر', '500 مل', 'معطر'], unit: 'عبوة', price: [20, 300], margin: [0.1, 0.18], carton: [6, 12], slow: true },
  { category: 'منتجات بالوزن', supplier: 'nuts', brands: ['لب سوري', 'لب أبيض', 'فول سوداني', 'كاجو', 'لوز', 'فستق', 'مكسرات مشكلة'], variants: ['محمص', 'مملح'], unit: 'كيلو', price: [90, 900], margin: [0.18, 0.3], weighted: true, season: 'ramadan' },
  { category: 'منتجات بالوزن', supplier: 'bulk', brands: ['أرز سائب', 'سكر سائب', 'عدس أصفر', 'فول تدميس', 'بلح سيوي', 'تمر مجدول', 'قمر الدين', 'زبيب'], variants: ['درجة أولى', 'اقتصادي'], unit: 'كيلو', price: [30, 450], margin: [0.1, 0.22], weighted: true, season: 'ramadan', warehouse: true },
  { category: 'بقالة جافة', supplier: 'grocery', brands: ['أرز الضحى', 'سكر الأسرة', 'مكرونة الملكة', 'مكرونة ريجينا', 'دقيق الضحى', 'ملح سيكيم'], variants: ['1 كيلو', '5 كيلو', '400 جم', 'اسباجتي', 'قلم', 'خواتم'], unit: 'كيس', price: [8, 190], margin: [0.07, 0.15], carton: [20, 10, 24], season: 'ramadan', warehouse: true },
  { category: 'بقالة جافة', supplier: 'oil', brands: ['زيت عافية', 'زيت كريستال', 'زيت هلا', 'سمن كريستال'], variants: ['800 مل', '1.6 لتر', '2.2 لتر', '700 جم'], unit: 'زجاجة', price: [60, 260], margin: [0.06, 0.12], carton: [12, 6], season: 'ramadan', warehouse: true },
  { category: 'بقالة جافة', supplier: 'tea', brands: ['شاي العروسة', 'شاي ليبتون', 'شاي الكبوس', 'نسكافيه', 'قهوة بن البرازيلي'], variants: ['40 جم', '250 جم', '100 فتلة', '25 فتلة', 'كلاسيك 3 في 1', 'جولد'], unit: 'علبة', price: [8, 220], margin: [0.1, 0.2], carton: [24, 12, 48], season: 'winter' },
  { category: 'بقالة جافة', supplier: 'bakery', brands: ['عيش فينو', 'توست', 'كرواسون', 'بقسماط'], variants: ['كيس', 'كبير', 'سادة', 'بالسمسم'], unit: 'كيس', price: [5, 40], margin: [0.15, 0.25], shelfLifeDays: [3, 6] },
  { category: 'عناية شخصية', supplier: 'unilever', brands: ['شامبو صانسيلك', 'شامبو كلير', 'صابون لوكس', 'صابون دوف', 'معجون سيجنال', 'مزيل ريكسونا'], variants: ['200 مل', '400 مل', '125 جم', 'عرض 3 قطع', 'رجالي'], unit: 'قطعة', price: [15, 160], margin: [0.12, 0.22], carton: [24, 12], slow: true },
  { category: 'عناية شخصية', supplier: 'pg', brands: ['هيد آند شولدرز', 'بانتين', 'جيليت', 'أولويز', 'بامبرز', 'كولجيت'], variants: ['صغير', 'وسط', 'كبير', 'مقاس 3', 'مقاس 4', 'اقتصادي'], unit: 'قطعة', price: [20, 420], margin: [0.08, 0.18], carton: [12, 6, 24], slow: true },
  { category: 'بقالة جافة', supplier: 'canned', brands: ['أدوات مدرسية — كشكول', 'أقلام بيك', 'مساطر', 'ألوان فلوماستر'], variants: ['40 ورقة', '60 ورقة', '100 ورقة', 'أزرق', 'أسود', '12 لون'], unit: 'قطعة', price: [5, 70], margin: [0.2, 0.35], carton: [24, 50], season: 'school', slow: true },
];

export interface SimProduct {
  key: string; name: string; category: string; supplier: string; unit: string; weighted: boolean;
  price: number; cost: number; cartonFactor: number | null; shelfLife: [number, number] | null;
  season: Season; warehouse: boolean;
  popularity: number; trend: 'stable' | 'rising' | 'falling' | 'dying' | 'new';
  launchDay: number; dieDay: number | null;
}

const round = (v: number, step: number) => Math.max(step, Math.round(v / step) * step);

export function buildCatalog(rng: Rng, target: number, days: number): SimProduct[] {
  const all: SimProduct[] = [];
  for (const t of TEMPLATES) {
    for (const b of t.brands) {
      for (const v of t.variants) {
        const priceEgp = rng.float(t.price[0], t.price[1]);
        const price = round(priceEgp * 100, priceEgp > 50 ? 100 : 25); // minor units
        const margin = rng.float(t.margin[0], t.margin[1]);
        const cost = Math.round(price / (1 + margin));
        all.push({
          key: `${b}|${v}`, name: `${b} ${v}`, category: t.category, supplier: t.supplier, unit: t.unit, weighted: !!t.weighted,
          price, cost, cartonFactor: t.carton ? rng.pick(t.carton) : null, shelfLife: t.shelfLifeDays ?? null,
          season: t.season ?? 'none', warehouse: !!t.warehouse, popularity: t.slow ? 0.25 : 1, trend: 'stable', launchDay: 0, dieDay: null,
        });
      }
    }
  }
  // extra "long tail" SKUs (sizes / promo packs) until the target count is reached
  let i = 0;
  const packs = ['عرض 2+1', 'عبوة توفير', 'حجم عائلي', 'إصدار خاص', 'سعر مخفض', 'عبوة هدية'];
  const base = [...all];
  while (all.length < target) {
    const src = base[i % base.length];
    const pack = packs[Math.floor(i / base.length) % packs.length];
    i++;
    if (src.weighted) continue;
    const mult = rng.float(1.4, 3);
    const price = round(src.price * mult, 25);
    all.push({ ...src, key: `${src.key}|${pack}`, name: `${src.name} ${pack}`, price, cost: Math.round(price / (src.price / src.cost)), popularity: src.popularity * 0.12 });
  }
  rng.shuffle(all);
  const list = all.slice(0, target);
  // Zipf popularity over a shuffled rank
  list.forEach((p, rank) => { p.popularity *= 1 / Math.pow(rank + 1, 0.85); });
  for (const p of list) {
    const r = rng.next();
    if (r < 0.1) p.trend = 'rising';
    else if (r < 0.2) p.trend = 'falling';
    else if (r < 0.26) { p.trend = 'dying'; p.dieDay = rng.int(60, Math.floor(days * 0.7)); }
    else if (r < 0.31) { p.trend = 'new'; p.launchDay = rng.int(90, Math.floor(days * 0.8)); }
  }
  return list;
}
