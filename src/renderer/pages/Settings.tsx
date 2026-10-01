import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Printer, Save, Settings as Gear, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { Field, NumberInput, PageHeader, Segmented, SettingRow, Switch, Tabs, useAction, useToast } from '../components/ui';
import { CURRENCIES, type StoreSettings } from '../../shared/settings';
import { StoreLogo, readImageFile } from './Auth';

type Tab = 'store' | 'mode' | 'sales' | 'inventory' | 'print' | 'display' | 'locations';

export default function Settings() {
  const { settings, setSettings, feature } = useApp();
  const toast = useToast();
  const { run, busy } = useAction();
  const [tab, setTab] = useState<Tab>('store');
  const [s, setS] = useState<StoreSettings>(settings);
  useEffect(() => setS(settings), [settings]);
  const set = <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => setS((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(s) !== JSON.stringify(settings);
  const save = () => run(async () => {
    const patch: Partial<StoreSettings> = {};
    for (const k of Object.keys(s) as (keyof StoreSettings)[]) if (JSON.stringify(s[k]) !== JSON.stringify(settings[k])) (patch as any)[k] = s[k];
    const next = await api('settings.update', patch);
    setSettings(next);
  }, 'تم حفظ الإعدادات');
  const sw = (k: keyof StoreSettings, title: string, desc?: string) => <SettingRow title={title} desc={desc}><Switch checked={!!s[k]} onChange={(v) => set(k, v as never)} /></SettingRow>;
  return (
    <div style={{ maxWidth: 900 }}>
      <PageHeader title="الإعدادات" icon={<Gear color="var(--primary)" />} actions={<button className="btn primary" disabled={!dirty || busy} onClick={save}><Save size={16} /> حفظ التغييرات</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'store', label: 'بيانات المحل' }, { value: 'mode', label: 'الوضع والمميزات' }, { value: 'sales', label: 'البيع' }, { value: 'inventory', label: 'المخزون' },
        { value: 'print', label: 'الطباعة' }, { value: 'display', label: 'العرض' }, { value: 'locations', label: 'أماكن التخزين والأسعار', hidden: !feature('multiLocation') && !feature('priceLists') },
      ]} />
      <div className="card pad">
        {tab === 'store' && (
          <div className="col">
            <div className="row top gap-lg">
              <div className="col" style={{ alignItems: 'center' }}>
                <StoreLogo name={s['store.name']} logo={s['store.logo']} />
                <label className="btn sm"><Upload size={14} /> تغيير الشعار<input type="file" hidden accept="image/png,image/jpeg,image/webp" onChange={async (e) => { const f = e.target.files?.[0]; if (f) { try { set('store.logo', await readImageFile(f)); } catch (err) { toast((err as Error).message, 'error'); } } }} /></label>
                {s['store.logo'] && <button className="btn ghost sm" onClick={() => set('store.logo', '')}>إزالة</button>}
              </div>
              <div className="form-grid grow">
                <Field label="اسم المحل" className="span-2"><input className="input" value={s['store.name']} onChange={(e) => set('store.name', e.target.value)} /></Field>
                <Field label="الهاتف"><input className="input" dir="ltr" value={s['store.phone']} onChange={(e) => set('store.phone', e.target.value)} /></Field>
                <Field label="الرقم الضريبي / السجل"><input className="input" value={s['store.taxNumber']} onChange={(e) => set('store.taxNumber', e.target.value)} /></Field>
                <Field label="العنوان" className="span-2"><input className="input" value={s['store.address']} onChange={(e) => set('store.address', e.target.value)} /></Field>
                <Field label="رسالة أسفل الفاتورة" className="span-2"><input className="input" value={s['store.receiptFooter']} onChange={(e) => set('store.receiptFooter', e.target.value)} /></Field>
                <Field label="العملة"><select className="select" value={s['currency.code']} onChange={(e) => { const c = CURRENCIES.find((x) => x.code === e.target.value)!; setS((x) => ({ ...x, 'currency.code': c.code, 'currency.symbol': c.symbol })); }}>{CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name}</option>)}</select></Field>
                <Field label="رمز العملة على الفاتورة"><input className="input" value={s['currency.symbol']} onChange={(e) => set('currency.symbol', e.target.value)} /></Field>
              </div>
            </div>
          </div>
        )}
        {tab === 'mode' && (
          <div className="col">
            <SettingRow title="طريقة العمل" desc="البسيط يخفي المميزات المتقدمة — نفس البرنامج ونفس البيانات.">
              <Segmented value={s.mode} onChange={(v) => set('mode', v)} options={[{ value: 'simple', label: 'بسيط' }, { value: 'advanced', label: 'متقدم' }]} />
            </SettingRow>
            {sw('features.creditSales', 'البيع الآجل', 'تسجيل مديونيات على العملاء (يحتاج صلاحية للكاشير)')}
            {sw('features.expiry', 'تواريخ الصلاحية والدفعات', 'طلب تاريخ الصلاحية عند الشراء، والبيع بالأقرب انتهاءً، ومنع بيع المنتهي، وتنبيهات قبل الانتهاء')}
            {sw('features.purchaseOrders', 'طلبات الشراء', 'طلب البضاعة من المورد قبل الاستلام')}
            {sw('features.promotions', 'العروض', 'خصومات وعروض (2 بـ…، اشترِ 3 والرابع مجانًا)')}
            {sw('features.priceLists', 'أسعار الجملة وقوائم الأسعار', 'سعر جملة/خاص لعملاء محددين')}
            {sw('features.quotations', 'عروض الأسعار', 'عرض سعر للعميل بدون تأثير على المخزون')}
            {sw('features.multiLocation', 'أكثر من مكان تخزين', 'محل + مخزن + ثلاجة… مع التحويل بينها')}
            {sw('features.tax', 'الضرائب', 'تطبيق ضريبة على المبيعات')}
          </div>
        )}
        {tab === 'sales' && (
          <div className="col">
            {sw('sales.requireShift', 'إلزام فتح وردية قبل البيع', 'لمطابقة الخزنة في نهاية كل وردية (موصى به)')}
            {sw('sales.allowNegativeStock', 'السماح بالبيع حتى لو الرصيد غير كافٍ', 'مفيد في البداية قبل تسجيل كل المخزون — يظهر تنبيه "رصيد بالسالب"')}
            {sw('sales.allowReturns', 'السماح بالمرتجعات')}
            <SettingRow title="مدة المرتجع (أيام)" desc="0 = بدون حد"><div style={{ width: 120 }}><NumberInput value={s['sales.returnDays']} onChange={(v) => set('sales.returnDays', v ?? 0)} /></div></SettingRow>
            <SettingRow title="أقصى خصم للكاشير بدون موافقة مدير (%)"><div style={{ width: 120 }}><NumberInput value={s['sales.maxDiscountPct']} onChange={(v) => set('sales.maxDiscountPct', v ?? 0)} /></div></SettingRow>
            <SettingRow title="بادئة رقم الفاتورة" desc="مثال: A- لتصبح A-000123"><input className="input" style={{ width: 120 }} value={s['sales.invoicePrefix']} onChange={(e) => set('sales.invoicePrefix', e.target.value)} /></SettingRow>
            <SettingRow title="تقريب إجمالي الفاتورة" desc="لتسهيل الفكة"><select className="select" style={{ width: 160 }} value={s['sales.roundTo']} onChange={(e) => set('sales.roundTo', Number(e.target.value))}><option value={0}>بدون تقريب</option><option value={25}>لأقرب ربع</option><option value={50}>لأقرب نصف</option><option value={100}>لأقرب واحد صحيح</option></select></SettingRow>
            {feature('tax') && <>
              <SettingRow title="نسبة الضريبة %"><div style={{ width: 120 }}><NumberInput value={s['tax.rate']} onChange={(v) => set('tax.rate', v ?? 0)} /></div></SettingRow>
              <SettingRow title="الأسعار شاملة الضريبة"><Switch checked={s['tax.inclusive']} onChange={(v) => set('tax.inclusive', v)} /></SettingRow>
            </>}
            <div className="section-title mt">باركود الميزان (للمنتجات الموزونة مسبقًا)</div>
            {sw('sales.scaleBarcode.enabled', 'قراءة باركود الميزان', 'باركود 13 رقم يبدأ برقم ثابت ويحتوي على كود المنتج والوزن أو السعر')}
            {s['sales.scaleBarcode.enabled'] && <>
              <SettingRow title="بادئة الباركود"><input className="input num-input" style={{ width: 100 }} value={s['sales.scaleBarcode.prefix']} onChange={(e) => set('sales.scaleBarcode.prefix', e.target.value)} /></SettingRow>
              <SettingRow title="عدد أرقام كود المنتج"><div style={{ width: 100 }}><NumberInput value={s['sales.scaleBarcode.codeLength']} onChange={(v) => set('sales.scaleBarcode.codeLength', v ?? 5)} /></div></SettingRow>
              <SettingRow title="الباركود يحتوي على"><Segmented value={s['sales.scaleBarcode.mode']} onChange={(v) => set('sales.scaleBarcode.mode', v)} options={[{ value: 'weight', label: 'الوزن بالجرام' }, { value: 'price', label: 'السعر' }]} /></SettingRow>
              <div className="small muted">كود المنتج في الباركود = "الكود الداخلي (SKU)" للمنتج.</div>
            </>}
          </div>
        )}
        {tab === 'inventory' && (
          <div className="col">
            <SettingRow title="صلاحية قريبة جدًا (يوم)" desc="تنبيه عاجل"><div style={{ width: 120 }}><NumberInput value={s['inventory.expiryCriticalDays']} onChange={(v) => set('inventory.expiryCriticalDays', v ?? 7)} /></div></SettingRow>
            <SettingRow title="تنبيه الصلاحية قبل (يوم)" desc="صلاحية قريبة"><div style={{ width: 120 }}><NumberInput value={s['inventory.expiryAlertDays']} onChange={(v) => set('inventory.expiryAlertDays', v ?? 30)} /></div></SettingRow>
            <SettingRow title="متابعة الصلاحية حتى (يوم)" desc="للعرض في شاشة الصلاحية فقط"><div style={{ width: 120 }}><NumberInput value={s['inventory.expiryWatchDays']} onChange={(v) => set('inventory.expiryWatchDays', v ?? 90)} /></div></SettingRow>
            <SettingRow title="اعتبار المنتج راكدًا إذا لم يُبع منذ (يوم)"><div style={{ width: 120 }}><NumberInput value={s['inventory.deadStockDays']} onChange={(v) => set('inventory.deadStockDays', v ?? 30)} /></div></SettingRow>
            <SettingRow title="اقتراحات الطلب تغطي (يوم)" desc="الكمية المقترحة تكفي البيع لهذه المدة بعد وصول البضاعة"><div style={{ width: 120 }}><NumberInput value={s['inventory.reorderCoverDays']} onChange={(v) => set('inventory.reorderCoverDays', v ?? 7)} /></div></SettingRow>
            <div className="section-title mt">اقتراحات البيع والعروض الذكية</div>
            <SettingRow title="فترة التحليل (يوم)" desc="المبيعات التي تُحسب منها سرعة الحركة"><div style={{ width: 120 }}><NumberInput value={s['intel.windowDays']} onChange={(v) => set('intel.windowDays', v ?? 30)} /></div></SettingRow>
            <SettingRow title="المخزون الزائد إذا كان يكفي أكثر من (يوم)" desc="أو 3 أضعاف المعتاد لنفس التصنيف — أيهما أكبر"><div style={{ width: 120 }}><NumberInput value={s['intel.excessCoverDays']} onChange={(v) => set('intel.excessCoverDays', v ?? 60)} /></div></SettingRow>
            <SettingRow title="الركود حسب إيقاع المنتج (×)" desc="يُعتبر راكدًا إذا توقف أكثر من هذا العدد من أضعاف معدله المعتاد"><div style={{ width: 120 }}><NumberInput value={s['intel.deadMultiplier']} onChange={(v) => set('intel.deadMultiplier', v ?? 3)} /></div></SettingRow>
            <SettingRow title="أقل هامش ربح مسموح للعروض %" desc="لا يُقترح عرض يقل هامشه عن هذا"><div style={{ width: 120 }}><NumberInput value={s['intel.minMarginPct']} onChange={(v) => set('intel.minMarginPct', v ?? 8)} /></div></SettingRow>
            <SettingRow title="أقصى خصم في العروض المقترحة %"><div style={{ width: 120 }}><NumberInput value={s['intel.maxDiscountPct']} onChange={(v) => set('intel.maxDiscountPct', v ?? 30)} /></div></SettingRow>
            <SettingRow title="عدد الاقتراحات المعروضة"><div style={{ width: 120 }}><NumberInput value={s['intel.maxSuggestions']} onChange={(v) => set('intel.maxSuggestions', v ?? 5)} /></div></SettingRow>
            <SettingRow title="أقصى مدة للوردية قبل التنبيه (ساعة)"><div style={{ width: 120 }}><NumberInput value={s['shift.maxHours']} onChange={(v) => set('shift.maxHours', v ?? 14)} /></div></SettingRow>
          </div>
        )}
        {tab === 'print' && <PrintSettings s={s} set={set} sw={sw} dirty={dirty} />}
        {tab === 'display' && (
          <div className="col">
            <SettingRow title="شكل الأرقام"><Segmented value={s['ui.digits']} onChange={(v) => set('ui.digits', v)} options={[{ value: 'latn', label: '123' }, { value: 'arab', label: '١٢٣' }]} /></SettingRow>
            <SettingRow title="حجم الخط"><Segmented value={String(s['ui.fontScale'])} onChange={(v) => set('ui.fontScale', Number(v))} options={[{ value: '0.9', label: 'صغير' }, { value: '1', label: 'عادي' }, { value: '1.1', label: 'كبير' }, { value: '1.2', label: 'كبير جدًا' }]} /></SettingRow>
          </div>
        )}
        {tab === 'locations' && <LocationsAndPrices />}
      </div>
    </div>
  );
}

function PrintSettings({ s, set, sw, dirty }: { s: StoreSettings; set: <K extends keyof StoreSettings>(k: K, v: StoreSettings[K]) => void; sw: (k: keyof StoreSettings, t: string, d?: string) => React.ReactNode; dirty: boolean }) {
  const printers = useQuery({ queryKey: ['printers'], queryFn: () => api<any[]>('print.printers') });
  const { run } = useAction();
  return (
    <div className="col">
      <SettingRow title="نوع الورق"><Segmented value={s['print.type']} onChange={(v) => set('print.type', v)} options={[{ value: 'thermal80', label: 'حراري 80 مم' }, { value: 'thermal58', label: 'حراري 58 مم' }, { value: 'a4', label: 'A4' }]} /></SettingRow>
      <SettingRow title="الطابعة" desc="اتركها على الافتراضية لاستخدام طابعة ويندوز الافتراضية">
        <select className="select" style={{ width: 260 }} value={s['print.printerName']} onChange={(e) => set('print.printerName', e.target.value)}>
          <option value="">الطابعة الافتراضية</option>{(printers.data ?? []).map((p) => <option key={p.name} value={p.name}>{p.displayName}{p.isDefault ? ' (افتراضية)' : ''}</option>)}
        </select>
      </SettingRow>
      {sw('print.autoPrint', 'طباعة الفاتورة تلقائيًا بعد الدفع')}
      {sw('print.showLogo', 'إظهار الشعار على الفاتورة')}
      <SettingRow title="عدد النسخ"><div style={{ width: 100 }}><NumberInput value={s['print.copies']} onChange={(v) => set('print.copies', Math.max(1, Math.min(v ?? 1, 5)))} /></div></SettingRow>
      <div className="row"><button className="btn" disabled={dirty} onClick={() => run(() => api('print.test'), 'تم إرسال صفحة الاختبار')}><Printer size={16} /> طباعة صفحة اختبار</button>{dirty && <span className="small muted">احفظ التغييرات أولًا</span>}</div>
    </div>
  );
}

function LocationsAndPrices() {
  const { feature } = useApp();
  const locs = useQuery({ queryKey: ['locations'], queryFn: () => api<any[]>('locations.list') });
  const lists = useQuery({ queryKey: ['priceLists'], queryFn: () => api<any[]>('priceLists.list') });
  const [loc, setLoc] = useState({ name: '', type: 'warehouse' });
  const [pl, setPl] = useState('');
  const { run } = useAction();
  const types: Record<string, string> = { shop: 'محل', warehouse: 'مخزن', fridge: 'ثلاجة', shelf: 'رف', branch: 'فرع', other: 'أخرى' };
  return (
    <div className="col gap-lg">
      {feature('multiLocation') && (
        <div>
          <div className="section-title">أماكن التخزين</div>
          {(locs.data ?? []).map((l) => <div key={l.id} className="row small" style={{ padding: '6px 0' }}><b>{l.name}</b><span className="badge">{types[l.type]}</span>{l.is_default ? <span className="badge primary">الافتراضي للبيع</span> : null}</div>)}
          <div className="row mt"><input className="input" style={{ width: 200 }} placeholder="اسم المكان" value={loc.name} onChange={(e) => setLoc({ ...loc, name: e.target.value })} />
            <select className="select" style={{ width: 130 }} value={loc.type} onChange={(e) => setLoc({ ...loc, type: e.target.value })}>{Object.entries(types).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
            <button className="btn" disabled={!loc.name.trim()} onClick={() => run(async () => { await api('locations.save', loc); setLoc({ name: '', type: 'warehouse' }); await locs.refetch(); })}><Plus size={14} /> إضافة</button></div>
        </div>
      )}
      {feature('priceLists') && (
        <div>
          <div className="section-title">قوائم الأسعار</div>
          {(lists.data ?? []).map((l) => <div key={l.id} className="small" style={{ padding: '4px 0' }}><b>{l.name}</b>{l.is_default ? ' (الأساسي)' : ''}</div>)}
          <div className="row mt"><input className="input" style={{ width: 220 }} placeholder="مثال: سعر المطاعم" value={pl} onChange={(e) => setPl(e.target.value)} /><button className="btn" disabled={!pl.trim()} onClick={() => run(async () => { await api('priceLists.save', { name: pl }); setPl(''); await lists.refetch(); })}><Plus size={14} /> إضافة</button></div>
          <div className="small muted mt">حدد سعر كل منتج في القائمة من صفحة المنتج، واربط العميل بالقائمة من صفحة العميل.</div>
        </div>
      )}
    </div>
  );
}
