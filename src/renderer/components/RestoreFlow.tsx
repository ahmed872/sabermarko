import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, FileSearch, FolderOpen, RotateCcw } from 'lucide-react';
import { api } from '../lib/api';
import { num } from '../lib/format';
import { useAction } from './ui';

const TYPE_LABEL: Record<string, string> = { manual: 'يدوية', auto: 'تلقائية', 'day-close': 'إغلاق يوم', 'before-restore': 'قبل استعادة', 'before-update': 'قبل تحديث', export: 'نسخة خارجية', invalid: 'ملف تالف' };

export function fmtBackupDate(iso: string) {
  try {
    const d = new Date(iso);
    return d.toLocaleString('ar-EG', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', numberingSystem: 'latn' } as Intl.DateTimeFormatOptions);
  } catch { return iso; }
}

/**
 * Restore wizard shared by: the first-run screen (new computer), the recovery screen
 * (damaged database) and the backup page. Steps: pick a backup -> the main process
 * validates it -> show what is inside + clear warning -> explicit confirmation ->
 * safety backup of current data -> restore -> verification counts.
 */
export function RestoreFlow({ onDone, onCancel, compact }: { onDone: (result: any) => void; onCancel?: () => void; compact?: boolean }) {
  const { run, busy } = useAction();
  const list = useQuery({ queryKey: ['backups-restore'], queryFn: () => api('backup.list') });
  const [picked, setPicked] = useState<{ token: string; info: any; otherStore?: boolean; freshInstall?: boolean } | null>(null);
  const [ok, setOk] = useState(false);
  const [done, setDone] = useState<any>(null);
  const inspect = (file?: string) => run(async () => {
    const r = await api('backup.inspect', file ? { file } : {});
    if (!r.canceled) { setPicked(r); setOk(false); }
  });
  if (done) {
    return (
      <div className="col">
        <div className="alert success"><CheckCircle2 size={18} /> تمت الاستعادة والتحقق من البيانات بنجاح.</div>
        <table className="table"><tbody>
          <tr><td>المنتجات</td><td className="n">{num(done.after?.products)}</td></tr>
          <tr><td>الفواتير</td><td className="n">{num(done.after?.sales)}</td></tr>
          <tr><td>المشتريات</td><td className="n">{num(done.after?.purchases)}</td></tr>
          <tr><td>العملاء / الموردون</td><td className="n">{num(done.after?.customers)} / {num(done.after?.suppliers)}</td></tr>
        </tbody></table>
        <button className="btn primary lg" onClick={() => onDone(done)}>متابعة لتسجيل الدخول</button>
      </div>
    );
  }
  if (!picked) {
    const items = (list.data?.items ?? []).filter((b: any) => b.reason !== 'invalid');
    return (
      <div className="col">
        {items.length > 0 && <div className="small muted">النسخ الموجودة في مجلد النسخ الاحتياطية ({list.data?.dir}):</div>}
        {items.slice(0, compact ? 5 : 10).map((b: any) => (
          <button key={b.file} className="btn block" style={{ justifyContent: 'space-between', height: 'auto', padding: '10px 14px' }} onClick={() => inspect(b.file)}>
            <span className="bold">{b.storeName}</span>
            <span className="small muted">{TYPE_LABEL[b.reason] ?? b.reason} • {num(b.fileSize / 1024 / 1024, 1)} ميجا</span>
            <span className="num">{fmtBackupDate(b.createdAt)}</span>
          </button>
        ))}
        <button className="btn" onClick={() => inspect()}><FolderOpen size={16} /> اختيار ملف نسخة احتياطية من الجهاز أو الفلاشة…</button>
        {onCancel && <button className="btn ghost" onClick={onCancel}>رجوع</button>}
      </div>
    );
  }
  const i = picked.info;
  return (
    <div className="col">
      <div className="alert success"><FileSearch size={18} /> تم فحص الملف: سليم ومتوافق مع هذا الإصدار.</div>
      <table className="table"><tbody>
        <tr><td>اسم المحل داخل النسخة</td><td className="bold">{i.storeName}</td></tr>
        <tr><td>تاريخ النسخة</td><td className="num">{fmtBackupDate(i.createdAt)}</td></tr>
        <tr><td>نوع النسخة</td><td>{TYPE_LABEL[i.reason] ?? i.reason}</td></tr>
        <tr><td>إصدار البرنامج الذي أنشأها</td><td className="num">{i.appVersion} (قاعدة بيانات v{i.schemaVersion})</td></tr>
        <tr><td>المحتوى</td><td>{num(i.counts?.products)} منتج • {num(i.counts?.sales)} فاتورة • {num(i.counts?.customers)} عميل • {num(i.counts?.suppliers)} مورد</td></tr>
      </tbody></table>
      {i.migrationNeeded && <div className="alert info small">النسخة من إصدار أقدم — سيتم تحديث بنيتها تلقائيًا بعد الاستعادة دون فقد بيانات.</div>}
      {picked.otherStore && <div className="alert danger small"><AlertTriangle size={16} /> هذه النسخة تخص محلًا آخر غير المحل الحالي.</div>}
      {!picked.freshInstall && <div className="alert warning"><AlertTriangle size={18} /> سيتم استبدال كل البيانات الحالية بمحتوى هذه النسخة. سيحفظ البرنامج نسخة أمان من بياناتك الحالية أولًا تلقائيًا، وإذا فشلت الاستعادة ترجع بياناتك كما كانت.</div>}
      <label className="check"><input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} /> فهمت وأريد استعادة هذه النسخة</label>
      <div className="row">
        <button className="btn danger lg" disabled={!ok || busy} onClick={() => run(async () => setDone(await api('backup.restore', { token: picked.token })))}><RotateCcw size={16} /> {busy ? 'جارٍ الاستعادة…' : 'استعادة الآن'}</button>
        <button className="btn" disabled={busy} onClick={() => setPicked(null)}>اختيار نسخة أخرى</button>
      </div>
    </div>
  );
}
