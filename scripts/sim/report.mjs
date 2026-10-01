// Builds docs/SIMULATION_REPORT.md from the JSON produced by simulate / verify / restore-tests.
//   node scripts/sim/report.mjs --out sim-output
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

const args = process.argv.slice(2);
const OUT = resolve(args[args.indexOf('--out') + 1] ?? 'sim-output');
const sim = JSON.parse(readFileSync(join(OUT, 'sim-log.json'), 'utf8'));
const ver = JSON.parse(readFileSync(join(OUT, 'verify-report.json'), 'utf8'));
const res = JSON.parse(readFileSync(join(OUT, 'restore-report.json'), 'utf8'));
const verRestored = existsSync(join(OUT, 'verify-report-restored.json')) ? JSON.parse(readFileSync(join(OUT, 'verify-report-restored.json'), 'utf8')) : null;
const tamper = existsSync(join(OUT, 'verify-report-tamper.json')) ? JSON.parse(readFileSync(join(OUT, 'verify-report-tamper.json'), 'utf8')) : null;
const c = sim.counts;
const n = (v) => (v ?? 0).toLocaleString('en-US');
const egp = (minor) => `${(Math.round((minor ?? 0) / 100)).toLocaleString('en-US')} ج.م`;
const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
const pct = (a, b) => (b ? `${((a / b) * 100).toFixed(1)}%` : '—');
const L = [];
const p = (s = '') => L.push(s);
const table = (head, rows) => { p(`| ${head.join(' | ')} |`); p(`|${head.map(() => '---').join('|')}|`); for (const r of rows) p(`| ${r.join(' | ')} |`); p(); };

p('# تقرير محاكاة سنة تشغيل كاملة — SaberMarko POS');
p();
p(`> تم توليد هذا التقرير آليًا من مخرجات المحاكاة (\`scripts/sim/\`). البيانات **وهمية بالكامل** وتم إنشاؤها في مجلد اختبار منفصل
> (\`${'sim-output/'}\`) — لم تُشغَّل على أي تثبيت حقيقي ولا تدخل في أي مُثبّت. البذرة: ${sim.config.seed}، البداية ${sim.config.start}، ${sim.config.days} يومًا.`);
p();
p('## كيف تم الاختبار');
p('- **المحاكي** يستخدم نفس محرك البرنامج الحقيقي (نفس الخدمات التي تستدعيها الواجهة) ويشغّل سنة كاملة لمحل به '
  + `${n(c['products.created'])} صنفًا، ويحتفظ في نفس الوقت **بنموذج ظل مستقل** (المخزون لكل صنف ومكان، نقدية كل درج، أرصدة العملاء والموردين) محسوب فقط مما فعله الأشخاص المحاكَون.`);
p('- **المدقق المستقل** (`verify.ts`) لا يستورد أي كود من البرنامج: يفتح قاعدة البيانات بـ SQL خام ويعيد حساب كل شيء ثم يقارن بما سجّله البرنامج وبنموذج الظل.');
p('- **اختبارات الاستعادة** تستعيد نسخ اليوم الأول/الشهر 1/6/12 في تثبيتات منفصلة وتقارن المحتوى جدولًا بجدول، وتجرب ملفات تالفة وإصدارات مختلفة وسيناريوهات كوارث.');
p();
p('## 1. حجم السنة المحاكاة');
table(['البند', 'العدد'], [
  ['الفواتير الناجحة', n(c['sales.ok'])], ['أسطر الفواتير', n(c['sales.lines'])], ['أسطر بالوزن', n(c['sales.weightedLines'])], ['أسطر بالكرتونة', n(c['sales.cartonLines'])],
  ['دفع نقدي / بطاقة / محفظة / آجل', `${n(c['sales.method.cash'])} / ${n(c['sales.method.card'])} / ${n(c['sales.method.wallet'])} / ${n(c['sales.method.credit'])}`],
  ['فواتير بخصم', n(c['sales.discounted'])], ['خصومات احتاجت موافقة المدير', n(c['sales.approvedDiscount'])], ['أسطر عليها عرض ترويجي', n(c['sales.promoLines'])],
  ['مرتجعات (منها غير معاد للمخزون)', `${n(c['returns.ok'])} (${n(c['returns.notRestocked'])})`], ['فواتير ملغاة بموافقة', n(c['sales.voided'])],
  ['فواتير معلّقة ثم استكملت / حُذفت', `${n((c['held.created'] ?? 0) - (c['held.deleted'] ?? 0))} / ${n(c['held.deleted'])}`], ['عروض أسعار / تحولت لفواتير', `${n(c['quotations.created'])} / ${n(c['quotations.converted'])}`],
  ['فواتير شراء (منها من أوامر شراء)', `${n(c['purchases.ok'])} (${n(c['purchases.fromPO'])})`], ['أوامر شراء / استلام جزئي', `${n(c['po.created'])} / ${n(c['po.partial'])}`],
  ['زيادات أسعار من الموردين / رفع سعر بيع', `${n(c['suppliers.priceRaises'])} / ${n(c['prices.raised'])}`], ['مرتجعات للموردين', n(c['purchaseReturns.ok'])],
  ['تحويلات مخزن ← محل (أسطر)', `${n(c['transfers.ok'])} (${n(c['transfers.lines'])})`], ['إعدام منتهي الصلاحية', n(c['adjust.expiredDisposed'])], ['تالف / عجز', `${n(c['adjust.damage'])} / ${n(c['adjust.loss'])}`],
  ['جرد (أصناف تم عدّها)', `${n(c['stocktakes.ok'])} (${n(c['stocktakes.items'])})`], ['مصروفات (منها من الدرج)', `${n(c['expenses.ok'])} (${n(c['expenses.drawer'])})`],
  ['تحصيلات من العملاء / سداد موردين', `${n(c['collections.ok'])} / ${n(c['supplierPayments.ok'])}`], ['ورديات (عجز / زيادة متعمدة)', `${n(c['shifts.closed'])} (${n(c['shifts.short'])} / ${n(c['shifts.over'])})`],
  ['أيام أُغلقت', n(c['days.closed'])], ['أسطر لم تُبع لنفاد الرف (طلب ضائع)', `${n(c['sales.lostLine'])} (${pct(c['sales.lostLine'], (c['sales.lines'] ?? 0) + (c['sales.lostLine'] ?? 0))})`],
  ['أخطاء غير متوقعة من البرنامج', n(sim.errors.length)], ['زمن المحاكاة', `${n(c.wallSeconds)} ثانية`],
]);
p('## 2. النتائج المالية الشهرية (كما أعاد المدقق حسابها من البيانات الخام)');
table(['الشهر', 'فواتير', 'صافي المبيعات', 'تكلفة البضاعة', 'مجمل الربح', 'المصروفات', 'صافي الربح', 'الهامش'],
  ver.pnlMonths.map((m) => [m.month, n(m.invoices), egp(m.netSales), egp(m.cogs), egp(m.grossProfit), egp(m.expenses), egp(m.netProfit), pct(m.grossProfit, m.netRevenue)]));
const y = ver.questions.year;
p(`**إجمالي السنة:** ${n(y.invoices)} فاتورة — صافي مبيعات ${egp(y.netSales)} — تكلفة ${egp(y.cogs)} — مجمل ربح ${egp(y.grossProfit)} (${pct(y.grossProfit, y.netRevenue)}) — مصروفات ${egp(y.expenses)} — صافي ربح ${egp(y.netProfit)}.`);
p();
p('## 3. المطابقة المستقلة (المخزون والمال)');
table(['الفحص', 'عدد ما تم فحصه', 'النتيجة'], ver.checks.map((x) => [x.name, n(x.checked), x.ok ? '✅ مطابق' : `❌ ${x.failures} اختلاف`]));
p(`**${ver.checks.filter((x) => x.ok).length} من ${ver.checks.length} فحصًا ناجحًا.**`);
p();
p('### حركة المخزون الشهرية: الافتتاحي + الوارد − المنصرف = الختامي (بالوحدة الأساسية × 1000)');
table(['الشهر', 'افتتاحي', 'وارد', 'منصرف', 'ختامي (الدفتر)', 'لقطة ليلة آخر الشهر', 'اختلافات على مستوى الصنف'],
  ver.monthly.map((m) => [m.month, n(m.opening), n(m.in), n(m.out), n(m.closing), n(m.snapshot), m.snapDiffs ? `❌ ${m.snapDiffs}` : '0 ✅']));
if (tamper) {
  p('### هل المدقق قادر فعلًا على اكتشاف الأخطاء؟');
  p(`تم عمل نسخة من قاعدة السنة وتعديل 3 قيم يدويًا (رصيد صنف +1، إجمالي فاتورة +1 ج.م، رصيد عميل +5 ج.م) ثم تشغيل المدقق عليها: اكتشف **${tamper.checks.filter((x) => !x.ok).length}** فحوصات فاشلة:`);
  for (const x of tamper.checks.filter((x) => !x.ok)) p(`- ${x.name}`);
  p();
}
p('## 4. النسخ الاحتياطي');
const b = res.backups;
table(['البند', 'القيمة'], [
  ['نسخ أُنشئت خلال السنة (يومية بعد الإغلاق)', n(b.createdDuringYear)], ['تم التحقق منها لحظة إنشائها', `${n(b.verifiedAtCreation)} (${pct(b.verifiedAtCreation, b.createdDuringYear)})`],
  ['فشل إنشاء', n(b.failedAtCreation)], ['المحفوظ على القرص بعد سياسة الاحتفاظ (يومي/أسبوعي/شهري)', `${b.retention.daily} / ${b.retention.weekly} / ${b.retention.monthly} + 4 نقاط مرجعية`],
  ['أُعيد فحص كل المحفوظ: سليم', `${n(b.validOnDisk)} من ${n(b.keptOnDisk)}`], ['أكبر نسخة', `${b.largest.file} — ${mb(b.largest.size)}`],
  ['حجم أول نسخة / آخر نسخة', `${mb(b.firstSize)} / ${mb(b.lastSize)}`], ['متوسط / أقصى زمن إنشاء + تحقق', `${n(b.avgCreateMs)} / ${n(b.maxCreateMs)} مللي ثانية`],
]);
p('### الاستعادة في تثبيتات منفصلة');
table(['النسخة', 'النتيجة', 'الزمن', 'الفواتير بعد الاستعادة', 'مطابقة جدول بجدول', 'بيع بعد الاستعادة'],
  res.restores.map((r) => [r.label, r.ok ? '✅' : `❌ ${r.error ?? ''}`, `${n(r.ms)} ms`, n(r.counts?.sales), r.tablesDifferentFromBackup?.length === 0 ? (r.label === 'month-12' ? `مطابقة للنسخة وللمحل الأصلي (${r.tablesDifferentFromLiveStore?.length ? '❌' : '✅'})` : 'مطابقة ✅') : `❌ ${r.tablesDifferentFromBackup}`, r.saleAfterRestore ? `✅ ${r.saleAfterRestore}` : '—']));
if (verRestored) p(`تشغيل المدقق المستقل كاملًا على **نسخة الشهر 12 بعد استعادتها**: ${verRestored.checks.filter((x) => x.ok).length}/${verRestored.checks.length} فحص ناجح.`);
p();
p('### ملفات تالفة أو غير صالحة');
table(['الحالة', 'رُفضت؟', 'الرسالة للمستخدم', 'البيانات الحالية لم تُمس', 'البرنامج يعمل بعدها'],
  res.corruption.map((x) => [x.case, x.refused ? '✅' : '❌', x.message ?? '', x.liveDataUntouched ? '✅' : '❌', x.liveDbUsable ? '✅' : '❌']));
const o = res.oldVersion;
p(`**نسخة من إصدار أقدم (${o.from}) على هذا الإصدار (${o.to}):** ${o.ok ? `✅ تمت الاستعادة والترقية تلقائيًا (${n(o.ms)} ms)، والبيانات القديمة محفوظة («${o.promotionKept}»).` : `❌ ${o.error}`}`);
p();
p('**سياسة الإصدارات:** نسخة من إصدار أقدم ← تُستعاد ثم تُرقّى تلقائيًا للبنية الحالية بدون فقد. نسخة من إصدار **أحدث** من البرنامج ← تُرفض برسالة واضحة دون أي تغيير، والحل تحديث البرنامج أولًا.');
p();
p('### سيناريوهات الكوارث');
for (const r of res.recovery) p(`- ${r.scenario}: ${r.ok ? '✅' : `❌ ${r.error ?? ''}`}${r.ms ? ` (${n(r.ms)} ms)` : ''}${r.afterWrongRestoreInvoices !== undefined ? ` — بعد الخطأ ${n(r.afterWrongRestoreInvoices)} فاتورة، بعد التراجع ${n(r.afterUndoInvoices)} فاتورة، ونسخة الأمان في مجلد النسخ: ${r.safetyCopyInBackupFolder ? 'نعم' : 'لا'}` : ''}${r.ownerLogin ? ' — دخول المالك بكلمة مروره القديمة يعمل' : ''}`);
p(`\n**نسبة نجاح الاستعادة: ${res.summary.restoreSuccess}** — **رفض الملفات التالفة: ${res.summary.corruptionRefused}**`);
p();
p('## 5. الأداء بعد سنة من البيانات');
const f = res.performance;
table(['العملية', 'الزمن'], [
  ['حجم قاعدة البيانات', mb(f.dbBytes)], ['الصفوف', Object.entries(f.rows).map(([k, v]) => `${k}: ${n(v)}`).join('، ')],
  ['فتح القاعدة + الترقية + فحص السلامة', `${n(f.openMigrateQuickCheckMs)} ms`], ['بحث نقطة البيع بالاسم', `${f.posSearchTextMs} ms`], ['قائمة المنتجات', `${f.productsListMs} ms`],
  ['قائمة فواتير شهر', `${f.salesListMs} ms`], ['ملخص مالي لسنة كاملة', `${f.yearSummaryMs} ms`], ['لوحة التحكم', `${f.dashboardMs} ms`],
  ['أداء المنتجات لسنة (أعلى 50 ربحًا)', `${f.productPerformanceYearMs} ms`], ['تقييم المخزون', `${f.valuationMs} ms`], ['معاينة إغلاق اليوم', `${f.dayClosingPreviewMs} ms`],
  ['تحليل كل المنتجات (الذكاء)', `${f.intelMetricsMs} ms`], ['توليد الاقتراحات الشهرية', `${n(f.generateSuggestionsMs)} ms`],
  ['إتمام فاتورة (300 فاتورة على قاعدة السنة)', `متوسط ${f.checkoutAfterYear.avgMs} ms — p95 ${f.checkoutAfterYear.p95Ms} ms — أقصى ${f.checkoutAfterYear.maxMs} ms`],
  ['نسخة احتياطية لقاعدة السنة (مع التحقق)', `${n(f.backupYearMs)} ms — ${mb(f.backupYearBytes)}`], ['استعادة قاعدة السنة', `${n(f.restoreYearMs)} ms`],
]);
p('زمن إتمام الفاتورة على مدار السنة (من داخل المحاكاة):');
table(['الشهر', 'متوسط ms', 'p95 ms', 'أقصى ms', 'حجم القاعدة'], sim.months.map((m) => [m.label, m.checkout.avg.toFixed(2), m.checkout.p95.toFixed(2), m.checkout.max.toFixed(1), mb(m.dbBytes)]));
p('## 6. دورة العروض الذكية الشهرية');
table(['تاريخ التوليد', 'اقتراحات محسوبة', 'معروضة للمالك', 'اعتمد', 'رفض', 'أنواع المعروض', 'زمن التوليد'],
  sim.promotions.map((x) => [x.day, n(x.generated), n(x.shown), n(x.approved), n(x.decisions.filter((d) => d.decision === 'rejected').length), [...new Set(x.decisions.map((d) => d.kind))].join('، '), `${n(x.generateMs)} ms`]));
const pr = (sim.questions.promotionResults ?? []).filter((r) => r.before);
if (pr.length) {
  const verdicts = pr.reduce((a, r) => ({ ...a, [r.verdict]: (a[r.verdict] ?? 0) + 1 }), {});
  p(`نتائج ${pr.length} عرضًا اعتمدها المالك، مقاسة قبل/أثناء العرض بنفس طول الفترة: نجح ${verdicts.success ?? 0}، صرّف مخزونًا دون خسارة ${verdicts.clearance ?? 0}، زادت مبيعاته وقلّ ربحه ${verdicts.mixed ?? 0}، ضعيف ${verdicts.weak ?? 0}.`);
  p();
  table(['العرض', 'الأيام', 'وحدات قبل ← أثناء', 'مجمل ربح قبل ← أثناء', 'الهامش قبل ← أثناء', 'تخفيض المخزون', 'التقييم'],
    pr.slice(0, 15).map((r) => [r.promotion.name, n(r.days), `${n(Math.round(r.mainBefore.units / 1000))} ← ${n(Math.round(r.mainDuring.units / 1000))}`, `${egp(r.before.profit)} ← ${egp(r.during.profit)}`,
      `${r.marginBefore == null ? '—' : r.marginBefore.toFixed(1) + '%'} ← ${r.marginDuring == null ? '—' : r.marginDuring.toFixed(1) + '%'}`, r.stockReductionPct == null ? '—' : `${r.stockReductionPct.toFixed(0)}%`, r.text]));
}
p('## 7. أسئلة المالك في نهاية السنة (محسوبة بـ SQL خام)');
const q = ver.questions;
p('**أعلى 10 أصناف إيرادًا:** ' + q.topByRevenue.map((r) => `${r.name} (${egp(r.revenue)})`).join('، '));
p();
p('**أعلى 10 أصناف ربحًا:** ' + q.topByProfit.map((r) => `${r.name} (${egp(r.profit)})`).join('، '));
p();
table(['القسم', 'الإيراد', 'مجمل الربح', 'الهامش'], q.categories.map((r) => [r.name, egp(r.revenue), egp(r.profit), pct(r.profit, r.revenue)]));
const days = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
p('**أيام الأسبوع:** ' + q.weekdays.map((r) => `${days[Number(r.dow)]} ${n(r.invoices)} فاتورة`).join('، ') + ` — أكثر الساعات ازدحامًا: ${q.hours.map((h) => `${h.hour}:00`).join('، ')}`);
p();
p(`**طرق الدفع:** ${q.paymentMix.map((r) => `${r.method} ${egp(r.amount)}`).join('، ')} — بيع آجل: ${n(q.creditSales.n)} فاتورة بقيمة ${egp(q.creditSales.amount)}.`);
p();
p(`**المخزون في نهاية السنة:** بالتكلفة ${egp(q.inventoryValue.cost)} وبسعر البيع ${egp(q.inventoryValue.retail)} — أصناف راكدة (لم تُبع 60 يومًا وعليها رصيد): ${n(q.deadAtYearEnd.n)} بقيمة ${egp(q.deadAtYearEnd.value)}.`);
p();
p(`**الفاقد:** إعدام منتهي الصلاحية ${n(q.expiredDisposed.events)} مرة بقيمة ${egp(q.expiredDisposed.value)}؛ ` + q.shrinkage.map((r) => `${r.type}: ${n(r.events)} حركة (${egp(r.value)})`).join('، ') + '.');
p();
p(`**الديون:** العملاء مدينون للمحل بـ ${egp(q.debts.customersOwe)}، والمحل مدين للموردين بـ ${egp(q.debts.weOwe)}.`);
p();
table(['الكاشير', 'ورديات', 'ورديات بعجز', 'صافي الفروق'], q.cashiers.map((r) => [r.name, n(r.shifts), n(r.short), egp(r.variance)]));
p('## 8. ما اكتشفته المحاكاة وتم إصلاحه');
p('- اقتراح عرض خصم على كمية **منتهية الصلاحية بالفعل** (مخالف قانونيًا) ← أصبحت الكمية المنتهية تُعرض كـ«يجب إعدامها ولا تُباع» فقط، ولا يمتد أي عرض بعد تاريخ الصلاحية.');
p('- خصم 30% ثابت على ألبان هامشها 10–15% (خسارة مؤكدة) ← يختار الآن أكبر خصم يظل فوق التكلفة، ولا يقترح خصمًا تحت التكلفة إلا كـ«يحتاج مراجعة».');
p('- قائمة الاقتراحات كانت تمتلئ بعروض صلاحية صغيرة القيمة فتختفي البضاعة الراكدة ← تجاهل الكميات التافهة، وتأخير العروض الخاسرة في الترتيب، وتنويع القائمة المعروضة.');
p('- نسخة الأمان قبل الاستعادة كانت تُحفظ في مجلد مخفي ← أصبحت في مجلد النسخ الاحتياطية ليمكن التراجع عن استعادة خاطئة من الشاشة.');
p();
p('## 9. حدود هذه المحاكاة (بأمانة)');
p('- العملاء والطلب **نموذج احتمالي** وليس بيانات محل حقيقي؛ الأرقام المالية توضيحية وتهدف لاختبار صحة الحسابات وليس للتنبؤ.');
p('- المحاكاة تختبر محرك البرنامج وقاعدة البيانات بدون الواجهة الرسومية؛ الواجهة مغطاة باختبارات E2E منفصلة.');
p('- تمت على Linux. نفس المحرك يعمل على Windows لكن تشغيل البرنامج الفعلي على Windows 10/11 لم يُختبر على جهاز حقيقي.');
writeFileSync(join(resolve('docs'), 'SIMULATION_REPORT.md'), L.join('\n') + '\n');
console.log(`docs/SIMULATION_REPORT.md written (${L.length} lines)`);
