import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, Inbox, Info, X, XCircle } from 'lucide-react';
import { latinDigits } from '../../shared/arabic';
import { addDaysIso, isoDate, minorToInput, milliToInput, parseMoney, parseQty, todayIso } from '../lib/format';

/* ------------------------------------------------------------------ toast */
type ToastKind = 'info' | 'success' | 'error';
const ToastCtx = createContext<(msg: string, kind?: ToastKind) => void>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<{ id: number; msg: string; kind: ToastKind }[]>([]);
  const push = useCallback((msg: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((x) => [...x.slice(-2), { id, msg, kind }]);
    setTimeout(() => setItems((x) => x.filter((t) => t.id !== id)), kind === 'error' ? 6000 : 2500);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === 'error' ? <XCircle size={18} /> : t.kind === 'success' ? <CheckCircle2 size={18} /> : <Info size={18} />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

/** Wrap an async action: shows the Arabic error message as a toast. */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (success) toast(success, 'success');
      return r;
    } catch (e) {
      toast((e as Error).message || 'حدث خطأ', 'error');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, [toast]);
  return { run, busy };
}

/* ------------------------------------------------------------------ modal */
export function Modal({ title, onClose, children, footer, size, icon }: { title: ReactNode; onClose: () => void; children: ReactNode; footer?: ReactNode; size?: 'sm' | 'lg' | 'xl'; icon?: ReactNode }) {
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } };
    window.addEventListener('keydown', h, true);
    return () => window.removeEventListener('keydown', h, true);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal ${size ?? ''}`} role="dialog" aria-modal="true">
        <div className="modal-head">
          {icon}
          <h2>{title}</h2>
          <button className="btn ghost icon" onClick={onClose} aria-label="إغلاق"><X size={18} /></button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

type ConfirmOpts = { title: string; message: ReactNode; confirmText?: string; danger?: boolean; reason?: boolean };
const ConfirmCtx = createContext<(o: ConfirmOpts) => Promise<{ ok: boolean; reason: string }>>(async () => ({ ok: false, reason: '' }));
export const useConfirm = () => useContext(ConfirmCtx);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOpts & { resolve: (v: { ok: boolean; reason: string }) => void }) | null>(null);
  const [reason, setReason] = useState('');
  const confirm = useCallback((o: ConfirmOpts) => new Promise<{ ok: boolean; reason: string }>((resolve) => { setReason(''); setState({ ...o, resolve }); }), []);
  const close = (ok: boolean) => { state?.resolve({ ok, reason }); setState(null); };
  return (
    <ConfirmCtx.Provider value={confirm}>
      {children}
      {state && (
        <Modal title={state.title} onClose={() => close(false)} size="sm" icon={state.danger ? <AlertTriangle color="var(--danger)" /> : undefined}
          footer={<>
            <button className="btn" onClick={() => close(false)}>تراجع</button>
            <button className={`btn ${state.danger ? 'danger' : 'primary'}`} disabled={state.reason && !reason.trim() ? true : false} onClick={() => close(true)} autoFocus={!state.reason}>{state.confirmText ?? 'تأكيد'}</button>
          </>}>
          <div className="col">
            <div>{state.message}</div>
            {state.reason && <Field label="السبب (مطلوب)"><input className="input" autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>}
          </div>
        </Modal>
      )}
    </ConfirmCtx.Provider>
  );
}

/* ------------------------------------------------------------------ inputs */
export function Field({ label, children, help, error, className }: { label?: ReactNode; children: ReactNode; help?: ReactNode; error?: ReactNode; className?: string }) {
  return (
    <div className={`field ${className ?? ''}`}>
      {label && <label>{label}</label>}
      {children}
      {error ? <div className="err">{error}</div> : help ? <div className="help">{help}</div> : null}
    </div>
  );
}

/** Numeric text input that accepts Arabic digits and keeps a controlled numeric value. */
function NumericInput({ value, onChange, toText, parse, suffix, className, allowEmpty, ...rest }: {
  value: number | null; onChange: (v: number | null) => void; toText: (v: number | null) => string; parse: (s: string) => number | null; suffix?: ReactNode; className?: string; allowEmpty?: boolean;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  const [text, setText] = useState(toText(value));
  const last = useRef(value);
  useEffect(() => { if (value !== last.current) { setText(toText(value)); last.current = value; } }, [value, toText]);
  const input = (
    <input {...rest} className={`input num-input ${className ?? ''}`} inputMode="decimal" value={text}
      onFocus={(e) => { e.target.select(); rest.onFocus?.(e); }}
      onChange={(e) => {
        const t = latinDigits(e.target.value);
        setText(t);
        const v = t.trim() === '' ? (allowEmpty ? null : 0) : parse(t);
        if (v !== null || allowEmpty) { last.current = v; onChange(v); }
      }} />
  );
  if (!suffix) return input;
  return <div className="input-group">{input}<span className="addon">{suffix}</span></div>;
}

export function MoneyInput(p: { value: number | null; onChange: (v: number | null) => void; suffix?: ReactNode; allowEmpty?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <NumericInput {...p} toText={minorToInput} parse={parseMoney} />;
}
export function QtyInput(p: { value: number | null; onChange: (v: number | null) => void; suffix?: ReactNode; allowEmpty?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <NumericInput {...p} toText={milliToInput} parse={parseQty} />;
}
export function NumberInput(p: { value: number | null; onChange: (v: number | null) => void; suffix?: ReactNode; allowEmpty?: boolean } & Omit<React.InputHTMLAttributes<HTMLInputElement>, 'value' | 'onChange'>) {
  return <NumericInput {...p} toText={(v) => (v === null || v === undefined ? '' : String(v))} parse={(s) => { const n = Number(s.replace(/[,،]/g, '')); return Number.isFinite(n) ? n : null; }} />;
}

export function Switch({ checked, onChange, disabled, label }: { checked: boolean; onChange: (v: boolean) => void; disabled?: boolean; label?: string }) {
  return (
    <label className="switch" aria-label={label}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span />
    </label>
  );
}

export function SettingRow({ title, desc, children }: { title: ReactNode; desc?: ReactNode; children: ReactNode }) {
  return <div className="setting-row"><div className="txt"><div className="t">{title}</div>{desc && <div className="d">{desc}</div>}</div>{children}</div>;
}

export function Segmented<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[] }) {
  return <div className="seg">{options.map((o) => <button key={o.value} type="button" className={o.value === value ? 'on' : ''} onClick={() => onChange(o.value)}>{o.label}</button>)}</div>;
}

export function Tabs<T extends string>({ value, onChange, tabs }: { value: T; onChange: (v: T) => void; tabs: { value: T; label: ReactNode; hidden?: boolean }[] }) {
  return <div className="tabs">{tabs.filter((t) => !t.hidden).map((t) => <button key={t.value} className={t.value === value ? 'on' : ''} onClick={() => onChange(t.value)}>{t.label}</button>)}</div>;
}

/* ------------------------------------------------------------------ display */
export function Empty({ title, desc, icon, action }: { title: string; desc?: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return <div className="empty"><div className="icon">{icon ?? <Inbox size={26} />}</div><div className="t">{title}</div>{desc && <div className="d">{desc}</div>}{action && <div className="mt">{action}</div>}</div>;
}

export function Loading({ rows = 4 }: { rows?: number }) {
  return <div className="col" style={{ padding: 16 }}>{Array.from({ length: rows }).map((_, i) => <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />)}</div>;
}

export function PageHeader({ title, sub, actions, icon }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; icon?: ReactNode }) {
  return (
    <div className="page-header">
      {icon}
      <div><h1>{title}</h1>{sub && <div className="muted small">{sub}</div>}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function Stat({ label, value, hint, icon, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; icon?: ReactNode; tone?: 'primary' }) {
  return <div className={`card stat ${tone ?? ''}`}><div className="label">{icon}{label}</div><div className="value">{value}</div>{hint && <div className="hint">{hint}</div>}</div>;
}

export function Pager({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  if (total <= pageSize) return null;
  return (
    <div className="pager">
      <span className="muted">صفحة {page} من {pages} — {total} عنصر</span>
      <button className="btn sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>السابق</button>
      <button className="btn sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>التالي</button>
    </div>
  );
}

/* ------------------------------------------------------------------ dates */
export type Range = { from: string; to: string };
type Preset = 'today' | 'yesterday' | 'week' | 'month' | 'lastMonth' | '30' | 'custom';

export function presetRange(p: Preset): Range {
  const t = todayIso();
  const now = new Date();
  switch (p) {
    case 'today': return { from: t, to: t };
    case 'yesterday': { const y = addDaysIso(t, -1); return { from: y, to: y }; }
    case 'week': { const dow = (now.getDay() + 1) % 7; return { from: addDaysIso(t, -dow), to: t }; } // week starts Saturday
    case 'month': return { from: isoDate(new Date(now.getFullYear(), now.getMonth(), 1)), to: t };
    case 'lastMonth': return { from: isoDate(new Date(now.getFullYear(), now.getMonth() - 1, 1)), to: isoDate(new Date(now.getFullYear(), now.getMonth(), 0)) };
    case '30': return { from: addDaysIso(t, -29), to: t };
    default: return { from: t, to: t };
  }
}

export function DateRangePicker({ value, onChange, presets = ['today', 'yesterday', 'week', 'month', 'lastMonth'] }: { value: Range; onChange: (r: Range) => void; presets?: Preset[] }) {
  const labels: Record<Preset, string> = { today: 'اليوم', yesterday: 'أمس', week: 'هذا الأسبوع', month: 'هذا الشهر', lastMonth: 'الشهر الماضي', '30': 'آخر 30 يوم', custom: 'مخصص' };
  const active = presets.find((p) => { const r = presetRange(p); return r.from === value.from && r.to === value.to; });
  return (
    <div className="row wrap gap-sm">
      <div className="seg">{presets.map((p) => <button key={p} type="button" className={active === p ? 'on' : ''} onClick={() => onChange(presetRange(p))}>{labels[p]}</button>)}</div>
      <input type="date" className="input" style={{ width: 150 }} value={value.from} max={value.to} onChange={(e) => e.target.value && onChange({ ...value, from: e.target.value })} aria-label="من" />
      <span className="muted">إلى</span>
      <input type="date" className="input" style={{ width: 150 }} value={value.to} min={value.from} onChange={(e) => e.target.value && onChange({ ...value, to: e.target.value })} aria-label="إلى" />
    </div>
  );
}
