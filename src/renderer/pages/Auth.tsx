import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ArrowRight, Copy, KeyRound, LogIn, ShieldAlert, Store, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/app';
import { Field, useAction, useToast } from '../components/ui';
import { CURRENCIES } from '../../shared/settings';
import { initials } from '../../shared/arabic';
import { RestoreFlow } from '../components/RestoreFlow';

export function StoreLogo({ name, logo, className = 'auth-logo' }: { name?: string; logo?: string; className?: string }) {
  return <div className={className}>{logo ? <img src={logo} alt="" /> : initials(name || 'م')}</div>;
}

export function readImageFile(file: File, maxPx = 512): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!/^image\/(png|jpeg|webp|svg\+xml)$/.test(file.type)) return reject(new Error('صيغة الصورة غير مدعومة. استخدم PNG أو JPG.'));
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('تعذرت قراءة الصورة'));
    reader.onload = () => {
      const src = String(reader.result);
      if (file.type === 'image/svg+xml') return resolve(src);
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxPx / Math.max(img.width, img.height));
        const c = document.createElement('canvas');
        c.width = Math.round(img.width * scale);
        c.height = Math.round(img.height * scale);
        c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
        resolve(c.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('تعذرت قراءة الصورة'));
      img.src = src;
    };
    reader.readAsDataURL(file);
  });
}

/* ------------------------------------------------------------------ onboarding */

export function SetupWizard() {
  const { refresh, setSession } = useApp();
  const { run, busy } = useAction();
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [restoring, setRestoring] = useState(false);
  const [f, setF] = useState({
    storeName: '', phone: '', address: '', logo: '', currencyCode: 'EGP', currencySymbol: 'ج.م', adminName: '', adminUsername: 'admin',
    adminPassword: '', adminPassword2: '', starterCategories: true, mode: 'simple' as 'simple' | 'advanced', printType: 'thermal80' as 'thermal80' | 'thermal58' | 'a4',
  });
  const set = (k: keyof typeof f, v: unknown) => setF((x) => ({ ...x, [k]: v }));
  const steps = ['مرحبًا', 'بيانات المحل', 'العملة والطباعة', 'حساب المدير', 'جاهز'];
  const canNext = [true, f.storeName.trim().length > 0, true, f.adminName.trim() && f.adminUsername.trim().length >= 2 && f.adminPassword.length >= 4 && f.adminPassword === f.adminPassword2, true][step];

  const finish = () => run(async () => {
    const { adminPassword2: _x, ...data } = f;
    await api('setup.complete', { ...data, logo: data.logo || null });
    const res = await api('auth.login', { username: f.adminUsername, password: f.adminPassword });
    await refresh();
    setSession(res.user, res.settings);
  });

  if (restoring) {
    return (
      <div className="auth-bg">
        <div className="auth-card wide">
          <h1>استعادة بيانات محل موجود</h1>
          <p className="muted small">مناسب عند تغيير الكمبيوتر أو إعادة تثبيت البرنامج: اختر آخر نسخة احتياطية لمحلك وسيعود كل شيء كما كان (المنتجات، الفواتير، المخزون، العملاء، الموردون، المستخدمون).</p>
          <RestoreFlow onDone={() => void refresh()} onCancel={() => setRestoring(false)} />
        </div>
      </div>
    );
  }
  return (
    <div className="auth-bg">
      <div className="auth-card wide">
        <div className="steps">{steps.map((s, i) => <span key={s} className={i <= step ? 'on' : ''} />)}</div>
        {step === 0 && (
          <div className="col center" style={{ alignItems: 'center' }}>
            <div className="auth-logo"><Store size={34} /></div>
            <h1>أهلًا بك</h1>
            <p className="muted">خلال دقيقة واحدة سنجهز البرنامج باسم محلك. كل الخطوات بسيطة ويمكن تعديلها لاحقًا من الإعدادات.</p>
            <div className="alert info" style={{ textAlign: 'right' }}>تبدأ الآن فترة تجريبية كاملة لمدة 20 يومًا. البرنامج يعمل بدون إنترنت.</div>
            <button className="btn ghost" onClick={() => setRestoring(true)}>عندي نسخة احتياطية من البرنامج — استعادة بيانات محلي</button>
          </div>
        )}
        {step === 1 && (
          <div className="col">
            <h2>بيانات المحل</h2>
            <p className="muted small">هذه البيانات تظهر في أعلى الفاتورة وفي البرنامج.</p>
            <div className="row top gap-lg">
              <div className="col" style={{ alignItems: 'center' }}>
                <StoreLogo name={f.storeName} logo={f.logo} />
                <label className="btn sm"><Upload size={14} /> رفع شعار
                  <input type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={async (e) => {
                    const file = e.target.files?.[0];
                    if (!file) return;
                    try { set('logo', await readImageFile(file)); } catch (err) { toast((err as Error).message, 'error'); }
                  }} />
                </label>
                {f.logo && <button className="btn ghost sm" onClick={() => set('logo', '')}>إزالة</button>}
                <span className="xs muted">اختياري</span>
              </div>
              <div className="col grow">
                <Field label="اسم المحل *"><input className="input lg" autoFocus placeholder="مثال: سوبر ماركت البركة" value={f.storeName} onChange={(e) => set('storeName', e.target.value)} /></Field>
                <Field label="رقم الهاتف"><input className="input" dir="ltr" value={f.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
                <Field label="العنوان"><input className="input" value={f.address} onChange={(e) => set('address', e.target.value)} /></Field>
              </div>
            </div>
          </div>
        )}
        {step === 2 && (
          <div className="col">
            <h2>العملة والطباعة</h2>
            <Field label="العملة">
              <select className="select" value={f.currencyCode} onChange={(e) => { const c = CURRENCIES.find((x) => x.code === e.target.value)!; setF((x) => ({ ...x, currencyCode: c.code, currencySymbol: c.symbol })); }}>
                {CURRENCIES.map((c) => <option key={c.code} value={c.code}>{c.name} ({c.symbol})</option>)}
              </select>
            </Field>
            <Field label="نوع الطابعة / الورق" help="يمكن تغييره لاحقًا من الإعدادات.">
              <select className="select" value={f.printType} onChange={(e) => set('printType', e.target.value)}>
                <option value="thermal80">طابعة فواتير حرارية 80 مم (الأكثر شيوعًا)</option>
                <option value="thermal58">طابعة فواتير حرارية 58 مم</option>
                <option value="a4">طابعة عادية A4</option>
              </select>
            </Field>
            <Field label="طريقة العمل">
              <div className="col gap-sm">
                <label className="check"><input type="radio" checked={f.mode === 'simple'} onChange={() => set('mode', 'simple')} /> <span><b>الوضع البسيط</b> — مناسب للبقالة والميني ماركت: بيع، مخزون، مشتريات، تقارير.</span></label>
                <label className="check"><input type="radio" checked={f.mode === 'advanced'} onChange={() => set('mode', 'advanced')} /> <span><b>الوضع المتقدم</b> — للسوبر ماركت: الصلاحية والدفعات، طلبات الشراء، أسعار الجملة، العروض، أكثر من مكان تخزين.</span></label>
              </div>
            </Field>
            <label className="check"><input type="checkbox" checked={f.starterCategories} onChange={(e) => set('starterCategories', e.target.checked)} /> إضافة التصنيفات الشائعة (مشروبات، شيبسي، ألبان، مجمدات…)</label>
          </div>
        )}
        {step === 3 && (
          <div className="col">
            <h2>حساب المدير</h2>
            <p className="muted small">هذا الحساب له كل الصلاحيات. يمكنك إضافة حسابات للكاشير لاحقًا.</p>
            <Field label="الاسم"><input className="input" autoFocus value={f.adminName} onChange={(e) => set('adminName', e.target.value)} /></Field>
            <Field label="اسم المستخدم (للدخول)"><input className="input" dir="ltr" value={f.adminUsername} onChange={(e) => set('adminUsername', e.target.value)} /></Field>
            <div className="grid grid-2">
              <Field label="كلمة المرور" help="4 أحرف على الأقل"><input className="input" type="password" value={f.adminPassword} onChange={(e) => set('adminPassword', e.target.value)} /></Field>
              <Field label="تأكيد كلمة المرور" error={f.adminPassword2 && f.adminPassword !== f.adminPassword2 ? 'كلمتا المرور غير متطابقتين' : undefined}><input className="input" type="password" value={f.adminPassword2} onChange={(e) => set('adminPassword2', e.target.value)} /></Field>
            </div>
          </div>
        )}
        {step === 4 && (
          <div className="col center" style={{ alignItems: 'center' }}>
            <StoreLogo name={f.storeName} logo={f.logo} />
            <h1>{f.storeName}</h1>
            <p className="muted">كل شيء جاهز. الخطوة التالية: أضف أول منتج وابدأ البيع.</p>
          </div>
        )}
        <div className="row mt" style={{ marginTop: 22 }}>
          {step > 0 && <button className="btn" onClick={() => setStep(step - 1)}><ArrowRight size={16} /> السابق</button>}
          <div className="grow" />
          {step < steps.length - 1
            ? <button className="btn primary lg" disabled={!canNext} onClick={() => setStep(step + 1)}>التالي <ArrowLeft size={16} /></button>
            : <button className="btn primary lg" disabled={busy} onClick={finish}>ابدأ استخدام البرنامج</button>}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ login */

export function LoginScreen() {
  const { boot, setSession } = useApp();
  const users = useQuery({ queryKey: ['loginUsers'], queryFn: () => api<{ username: string; full_name: string }[]>('auth.loginUsers') });
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (users.data?.length === 1 && !username) setUsername(users.data[0].username); }, [users.data, username]);
  const s = boot?.settings ?? {};
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api('auth.login', { username, password });
      setSession(res.user, res.settings);
    } catch (err) {
      setError((err as Error).message);
      setPassword('');
    } finally { setBusy(false); }
  };
  return (
    <div className="auth-bg">
      <form className="auth-card" onSubmit={submit}>
        <StoreLogo name={s['store.name']} logo={s['store.logo']} />
        <h1 className="center">{s['store.name'] || 'تسجيل الدخول'}</h1>
        <p className="center muted small">سجّل الدخول للمتابعة</p>
        <LicenseHint />
        {(users.data?.length ?? 0) > 1 && (
          <div className="user-pick mb">
            {users.data!.map((u) => <button type="button" key={u.username} className={u.username === username ? 'on' : ''} onClick={() => setUsername(u.username)}>{u.full_name}</button>)}
          </div>
        )}
        <div className="col">
          <Field label="اسم المستخدم"><input className="input lg" dir="ltr" value={username} onChange={(e) => setUsername(e.target.value)} autoFocus={!username} /></Field>
          <Field label="كلمة المرور"><input className="input lg" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus={!!username} /></Field>
          {error && <div className="alert danger">{error}</div>}
          <button className="btn primary lg block" disabled={busy || !username || !password}><LogIn size={18} /> دخول</button>
        </div>
        <div className="center xs muted" style={{ marginTop: 16 }}>{boot?.vendor?.productNameAr} — الإصدار {boot?.version}</div>
      </form>
    </div>
  );
}

function LicenseHint() {
  const { boot } = useApp();
  const l = boot?.license;
  if (!l || l.state !== 'trial') return null;
  return <div className="alert info mb small">فترة تجريبية — متبقٍ {l.daysLeft} يوم</div>;
}

/* ------------------------------------------------------------------ license */

export function LicensePanel({ onActivated }: { onActivated?: () => void }) {
  const { boot, refresh } = useApp();
  const toast = useToast();
  const { run, busy } = useAction();
  const [key, setKey] = useState('');
  const status = useQuery({ queryKey: ['license'], queryFn: () => api('license.status'), initialData: boot?.license });
  const l = status.data;
  const stateText: Record<string, string> = {
    trial: `فترة تجريبية — متبقٍ ${l?.daysLeft ?? 0} يوم (تنتهي ${l?.trialEndsAt ?? ''})`,
    licensed: l?.type === 'permanent' ? 'مفعّل — ترخيص دائم' : `مفعّل — ترخيص مؤقت حتى ${l?.expiresAt} (متبقٍ ${l?.daysLeft} يوم)`,
    expired: l?.type === 'trial' ? 'انتهت الفترة التجريبية' : `انتهى الترخيص بتاريخ ${l?.expiresAt}`,
    tampered: 'تم اكتشاف تعديل غير صحيح في ملفات الترخيص. يرجى التفعيل.',
    clock: 'تاريخ ووقت الجهاز غير صحيح. صحّح الوقت ثم أعد تشغيل البرنامج.',
  };
  return (
    <div className="col">
      <div className={`alert ${l?.canOperate ? (l.state === 'trial' ? 'info' : 'success') : 'danger'}`}>
        <KeyRound size={18} /> <div><b>{stateText[l?.state ?? 'trial']}</b>{l?.customer && <div className="small">مرخص لـ: {l.customer}</div>}{l?.limits && <div className="small">{l.limits.editionLabel ? `${l.limits.editionLabel} — ` : ''}الحد الأقصى للمستخدمين النشطين: {l.limits.maxUsers}</div>}</div>
      </div>
      <Field label="كود الجهاز" help="أرسل هذا الكود للشركة للحصول على كود التفعيل.">
        <div className="row">
          <input className="input num-input bold" readOnly value={l?.machineCode ?? ''} style={{ letterSpacing: 1 }} />
          <button className="btn" type="button" onClick={() => { void navigator.clipboard.writeText(l?.machineCode ?? ''); toast('تم نسخ كود الجهاز', 'success'); }}><Copy size={16} /> نسخ</button>
        </div>
      </Field>
      <Field label="كود التفعيل">
        <textarea className="input" dir="ltr" rows={3} placeholder="SBM1...." value={key} onChange={(e) => setKey(e.target.value)} />
      </Field>
      <button className="btn primary lg" disabled={busy || !key.trim()} onClick={() => run(async () => {
        await api('license.activate', { key });
        await status.refetch();
        await refresh();
        setKey('');
        onActivated?.();
      }, 'تم تفعيل البرنامج بنجاح')}>تفعيل</button>
      {boot?.vendor?.supportPhone && <div className="muted small">للدعم والتفعيل: <span dir="ltr">{boot.vendor.supportPhone}</span></div>}
    </div>
  );
}

export function LicenseBlocked() {
  const { boot, logout, can } = useApp();
  const { run } = useAction();
  return (
    <div className="auth-bg">
      <div className="auth-card wide">
        <div className="row mb"><ShieldAlert color="var(--danger)" size={28} /><h1>تفعيل البرنامج</h1></div>
        <p className="muted">{boot?.license.state === 'clock' ? 'لا يمكن المتابعة لأن تاريخ الجهاز يبدو أنه رجع للخلف.' : 'للمتابعة في البيع وإدارة المحل يرجى إدخال كود التفعيل. بياناتك محفوظة بالكامل ولم يُحذف أي شيء.'}</p>
        <LicensePanel />
        <div className="row mt">
          {can('backup.manage') && <button className="btn" onClick={() => run(() => api('backup.create'), 'تم إنشاء نسخة احتياطية من بياناتك')}>نسخة احتياطية من بياناتي</button>}
          <div className="grow" />
          <button className="btn ghost" onClick={() => void logout()}>تسجيل الخروج</button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ recovery */

export function RecoveryScreen() {
  const { refresh } = useApp();
  return (
    <div className="auth-bg">
      <div className="auth-card wide">
        <div className="row mb"><ShieldAlert color="var(--danger)" size={28} /><h1>استعادة البيانات</h1></div>
        <div className="alert danger mb">تعذر فتح قاعدة بيانات المحل بشكل سليم (قد يكون بسبب انقطاع الكهرباء أو عطل في القرص). اختر أحدث نسخة احتياطية لاستعادة بياناتك. الملف التالف لن يُحذف وسيُحفظ جانبًا.</div>
        <RestoreFlow onDone={() => void refresh()} />
      </div>
    </div>
  );
}
