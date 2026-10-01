import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatabaseBackup, FolderOpen, KeyRound, RotateCcw, ScrollText } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { dateTime, num } from '../lib/format';
import { DateRangePicker, Empty, Loading, Modal, PageHeader, SettingRow, Switch, NumberInput, presetRange, useAction, type Range } from '../components/ui';
import { LicensePanel } from './Auth';

export default function Admin({ tab }: { tab: 'audit' | 'backup' | 'license' }) {
  if (tab === 'audit') return <AuditPage />;
  if (tab === 'backup') return <BackupPage />;
  return <LicensePage />;
}

const ACTIONS: Record<string, string> = {
  'auth.login': 'تسجيل دخول', 'auth.logout': 'تسجيل خروج', 'setup.complete': 'إعداد البرنامج', 'product.create': 'إضافة منتج', 'product.update': 'تعديل منتج',
  'product.price_change': 'تغيير سعر بيع', 'product.cost_change': 'تغيير التكلفة', 'product.deactivate': 'إيقاف منتج', 'product.activate': 'تفعيل منتج', 'product.delete': 'حذف منتج',
  'sale.discount': 'خصم على فاتورة', 'sale.price_override': 'تعديل سعر في فاتورة', 'sale.credit': 'بيع آجل', 'sale.void': 'إلغاء فاتورة', 'sale.return': 'مرتجع بيع',
  'shift.open': 'فتح وردية', 'shift.close': 'إغلاق وردية', 'cash.withdrawal': 'سحب نقدية', 'cash.deposit': 'إضافة نقدية',
  'inventory.damage': 'تسجيل تلف', 'inventory.loss': 'تسجيل فقد', 'inventory.adjustment': 'تسوية مخزون', 'inventory.opening': 'رصيد افتتاحي', 'inventory.transfer': 'تحويل مخزون',
  'stocktake.start': 'بدء جرد', 'stocktake.complete': 'اعتماد جرد', 'stocktake.cancel': 'إلغاء جرد', 'purchase.create': 'فاتورة شراء', 'purchase.return': 'مرتجع شراء',
  'po.create': 'طلب شراء', 'po.update': 'تعديل طلب شراء', 'po.cancel': 'إلغاء طلب شراء', 'customer.create': 'إضافة عميل', 'customer.update': 'تعديل عميل', 'customer.payment': 'تحصيل من عميل',
  'customer.adjust_balance': 'تعديل رصيد عميل', 'supplier.create': 'إضافة مورد', 'supplier.update': 'تعديل مورد', 'supplier.payment': 'سداد مورد', 'supplier.adjust_balance': 'تعديل رصيد مورد',
  'expense.create': 'تسجيل مصروف', 'expense.delete': 'حذف مصروف', 'user.create': 'إضافة مستخدم', 'user.update': 'تعديل مستخدم', 'user.password_change': 'تغيير كلمة المرور',
  'role.create': 'إضافة دور', 'role.update': 'تعديل صلاحيات', 'settings.update': 'تعديل الإعدادات', 'day.close': 'إغلاق يوم', 'license.activate': 'تفعيل الترخيص', 'backup.restore': 'استعادة نسخة احتياطية',
  'promotion.create': 'إضافة عرض', 'promotion.update': 'تعديل عرض', 'promotion.delete': 'حذف عرض',
};

function describe(a: any): string {
  try {
    const o = a.old_value ? JSON.parse(a.old_value) : null;
    const n = a.new_value ? JSON.parse(a.new_value) : null;
    if (a.action === 'product.price_change') return `من ${(o.sellPrice / 100).toFixed(2)} إلى ${(n.sellPrice / 100).toFixed(2)}`;
    if (a.action === 'sale.void' || a.action === 'sale.discount' || a.action === 'sale.credit') return [n?.invoiceNo ?? o?.invoiceNo, n?.amount ? `المبلغ ${(n.amount / 100).toFixed(2)}` : o?.total ? `الإجمالي ${(o.total / 100).toFixed(2)}` : ''].filter(Boolean).join(' — ');
    if (a.action === 'shift.close') return `المتوقع ${(o.expected / 100).toFixed(2)} — الفعلي ${(n.counted / 100).toFixed(2)} — الفرق ${(n.variance / 100).toFixed(2)}`;
    if (a.action === 'sale.price_override') return `${n.product}: ${(o.price / 100).toFixed(2)} ← ${(n.price / 100).toFixed(2)}`;
    if (n && typeof n === 'object') return Object.entries(n).filter(([, v]) => typeof v !== 'object').slice(0, 4).map(([k, v]) => `${k}: ${v}`).join(' • ');
  } catch { /* ignore */ }
  return '';
}

function AuditPage() {
  const [range, setRange] = useState<Range>(presetRange('week'));
  const [userId, setUserId] = useState<number | ''>('');
  const [action, setAction] = useState('');
  const users = useQuery({ queryKey: ['userNames'], queryFn: () => api<any[]>('users.names') });
  const list = useQuery({ queryKey: ['audit', range, userId, action], queryFn: () => api<any[]>('audit.list', { ...range, userId: userId || null, action: action || null, limit: 500 }) });
  return (
    <div>
      <PageHeader title="سجل العمليات" sub="من فعل ماذا ومتى — للعمليات الحساسة" icon={<ScrollText color="var(--primary)" />} />
      <div className="row wrap mb">
        <DateRangePicker value={range} onChange={setRange} />
        <select className="select" style={{ width: 160 }} value={userId} onChange={(e) => setUserId(Number(e.target.value) || '')}><option value="">كل المستخدمين</option>{(users.data ?? []).map((u) => <option key={u.id} value={u.id}>{u.full_name}</option>)}</select>
        <select className="select" style={{ width: 200 }} value={action} onChange={(e) => setAction(e.target.value)}><option value="">كل العمليات</option>{Object.entries(ACTIONS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      </div>
      <div className="card">
        {list.isLoading ? <Loading /> : !list.data?.length ? <Empty title="لا توجد عمليات" /> : (
          <table className="table"><thead><tr><th>الوقت</th><th>المستخدم</th><th>العملية</th><th>التفاصيل</th><th>السبب</th><th>موافقة</th></tr></thead>
            <tbody>{list.data.map((a) => <tr key={a.id}><td className="num small">{dateTime(a.created_at)}</td><td>{a.user_name ?? 'النظام'}</td><td className="bold">{ACTIONS[a.action] ?? a.action}</td><td className="small">{describe(a)}</td><td className="small">{a.reason ?? ''}</td><td className="small">{a.approved_by_name ?? ''}</td></tr>)}</tbody></table>
        )}
      </div>
    </div>
  );
}

function BackupPage() {
  const { settings, setSettings } = useApp();
  const { run, busy } = useAction();
  const list = useQuery({ queryKey: ['backups'], queryFn: () => api('backup.list') });
  const [restore, setRestore] = useState<{ token: string; info: any } | null>(null);
  const upd = (patch: Record<string, unknown>) => run(async () => setSettings(await api('settings.update', patch)), 'تم الحفظ');
  const reasons: Record<string, string> = { manual: 'يدوي', auto: 'تلقائي', 'day-close': 'إغلاق يوم', 'before-restore': 'قبل استعادة', invalid: 'ملف تالف' };
  return (
    <div style={{ maxWidth: 1000 }}>
      <PageHeader title="النسخ الاحتياطي" icon={<DatabaseBackup color="var(--primary)" />} actions={<>
        <button className="btn" onClick={() => void api('backup.openDir')}><FolderOpen size={16} /> فتح المجلد</button>
        <button className="btn" onClick={() => run(async () => { const r = await api('backup.inspect', {}); if (!r.canceled) setRestore(r); })}><RotateCcw size={16} /> استعادة من ملف</button>
        <button className="btn" onClick={() => run(async () => { const r = await api('backup.createAs'); if (!r.canceled) await list.refetch(); }, undefined)}>حفظ نسخة في مكان آخر (فلاشة)</button>
        <button className="btn primary" disabled={busy} onClick={() => run(async () => { await api('backup.create'); await list.refetch(); }, 'تم إنشاء النسخة الاحتياطية بنجاح')}><DatabaseBackup size={16} /> نسخة احتياطية الآن</button>
      </>} />
      <div className="card pad mb">
        <SettingRow title="نسخ احتياطي تلقائي" desc="ينسخ البيانات في الخلفية بدون إزعاج"><Switch checked={settings['backup.auto']} onChange={(v) => void upd({ 'backup.auto': v })} /></SettingRow>
        <SettingRow title="نسخة عند إغلاق اليوم"><Switch checked={settings['backup.onDayClose']} onChange={(v) => void upd({ 'backup.onDayClose': v })} /></SettingRow>
        <SettingRow title="كل (ساعة)"><div style={{ width: 100 }}><NumberInput value={settings['backup.frequencyHours']} onChange={(v) => v && void upd({ 'backup.frequencyHours': v })} /></div></SettingRow>
        <SettingRow title="عدد النسخ التلقائية المحفوظة"><div style={{ width: 100 }}><NumberInput value={settings['backup.keep']} onChange={(v) => v && void upd({ 'backup.keep': v })} /></div></SettingRow>
        <SettingRow title="مجلد النسخ" desc={list.data?.dir}><button className="btn sm" onClick={() => run(async () => { const r = await api('backup.chooseDir'); if (!r.canceled) { await list.refetch(); setSettings(await api('settings.get')); } })}>تغيير المجلد</button></SettingRow>
        <div className="alert info small mt">نصيحة: انسخ نسخة احتياطية على فلاشة أو خارج الجهاز مرة أسبوعيًا على الأقل لحماية بياناتك من عطل القرص.</div>
      </div>
      <div className="card">
        {!list.data?.items.length ? <Empty title="لا توجد نسخ احتياطية بعد" /> : (
          <table className="table"><thead><tr><th>التاريخ</th><th>النوع</th><th>المحل</th><th className="n">الحجم</th><th>الإصدار</th><th /></tr></thead>
            <tbody>{list.data.items.map((b: any) => <tr key={b.file}><td className="num small">{dateTime(new Date(b.createdAt).toISOString().replace('Z', '').slice(0, 19))}</td><td>{reasons[b.reason ?? 'manual'] ?? b.reason}</td><td>{b.storeName}</td><td className="n">{num(b.fileSize / 1024, 0)} KB</td><td className="small">{b.appVersion}</td><td>{b.reason !== 'invalid' && <button className="btn sm" onClick={() => run(async () => setRestore(await api('backup.inspect', { file: b.file })))}>استعادة</button>}</td></tr>)}</tbody></table>
        )}
      </div>
      {restore && <RestoreDialog data={restore} onClose={() => setRestore(null)} />}
    </div>
  );
}

function RestoreDialog({ data, onClose }: { data: { token: string; info: any }; onClose: () => void }) {
  const { refresh } = useApp();
  const { run, busy } = useAction();
  const [ok, setOk] = useState(false);
  const i = data.info;
  return (
    <Modal title="استعادة نسخة احتياطية" onClose={onClose} footer={<button className="btn danger" disabled={!ok || busy} onClick={() => run(async () => { await api('backup.restore', { token: data.token }); await refresh(); }, 'تمت الاستعادة — سجّل الدخول مرة أخرى')}>استعادة الآن</button>}>
      <div className="col">
        <div className="alert success">الملف سليم وتم التحقق منه.</div>
        <table className="table"><tbody>
          <tr><td>المحل</td><td className="bold">{i.storeName}</td></tr><tr><td>تاريخ النسخة</td><td className="num">{new Date(i.createdAt).toLocaleString('ar-EG')}</td></tr>
          <tr><td>المنتجات</td><td>{i.counts?.products}</td></tr><tr><td>الفواتير</td><td>{i.counts?.sales}</td></tr><tr><td>المشتريات</td><td>{i.counts?.purchases}</td></tr>
        </tbody></table>
        <div className="alert warning">سيتم استبدال البيانات الحالية بهذه النسخة. سيحفظ البرنامج نسخة من بياناتك الحالية أولًا تلقائيًا للأمان.</div>
        <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> أفهم ذلك وأريد المتابعة</label>
      </div>
    </Modal>
  );
}

function LicensePage() {
  const { boot } = useApp();
  return (
    <div style={{ maxWidth: 700 }}>
      <PageHeader title="الترخيص والتفعيل" icon={<KeyRound color="var(--primary)" />} />
      <div className="card pad"><LicensePanel /></div>
      <div className="card pad mt small muted">
        <div>{boot?.vendor?.productNameAr} — الإصدار {boot?.version}</div>
        <div>تم التطوير بواسطة {boot?.vendor?.companyName}</div>
        <div className="mt">البرنامج يعمل بالكامل بدون إنترنت. التفعيل يتم بكود يُرسل لك ولا يحتاج اتصالًا.</div>
      </div>
    </div>
  );
}
