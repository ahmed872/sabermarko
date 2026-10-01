import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Plus, Shield, UserCog } from 'lucide-react';
import { api } from '../lib/api';
import { dateTime } from '../lib/format';
import { Empty, Field, Modal, NumberInput, PageHeader, Tabs, useAction } from '../components/ui';
import { PERMISSIONS, PERMISSION_GROUPS } from '../../shared/permissions';

export default function Users() {
  const [tab, setTab] = useState<'users' | 'roles'>('users');
  const [editUser, setEditUser] = useState<any | null>(null);
  const [editRole, setEditRole] = useState<any | null>(null);
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<any[]>('users.list') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<any[]>('roles.list') });
  const quota = useQuery({ queryKey: ['userQuota'], queryFn: () => api<{ active: number; max: number; canAdd: boolean }>('users.quota') });
  const full = quota.data ? !quota.data.canAdd : false;
  return (
    <div>
      <PageHeader title="المستخدمون والصلاحيات" icon={<UserCog color="var(--primary)" />} actions={tab === 'users'
        ? <>{quota.data && <span className={`badge ${full ? 'warning' : ''}`} title="عدد المستخدمين النشطين المسموح به في ترخيصك">المستخدمون النشطون: {quota.data.active} من {quota.data.max}</span>}
          <button className="btn primary" disabled={full} title={full ? 'وصلت للحد الأقصى — أوقف مستخدمًا أو قم بترقية الترخيص' : undefined} onClick={() => setEditUser({})}><Plus size={16} /> مستخدم جديد</button></>
        : <button className="btn primary" onClick={() => setEditRole({ permissions: [] })}><Plus size={16} /> دور جديد</button>} />
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'users', label: 'المستخدمون' }, { value: 'roles', label: 'الأدوار والصلاحيات' }]} />
      {tab === 'users' && full && <div className="alert warning small mb">وصلت للحد الأقصى لعدد المستخدمين النشطين في ترخيصك ({quota.data!.max}). لإضافة مستخدم جديد أوقف مستخدمًا غير مستخدم، أو قم بترقية الترخيص. المستخدم الموقوف لا يُحذف وتبقى فواتيره وسجله كما هي.</div>}
      {tab === 'users' && (
        <div className="card">
          {!users.data?.length ? <Empty title="لا يوجد مستخدمون" /> : (
            <table className="table"><thead><tr><th>الاسم</th><th>اسم الدخول</th><th>الدور</th><th className="n">حد الخصم</th><th>آخر دخول</th><th>الحالة</th></tr></thead>
              <tbody>{users.data.map((u) => <tr key={u.id} className="clickable" onClick={() => setEditUser(u)}><td className="bold">{u.full_name}</td><td className="num">{u.username}</td><td>{u.role_name}</td><td className="n">{u.max_discount_pct !== null ? `${u.max_discount_pct}%` : 'افتراضي'}</td><td className="num small">{dateTime(u.last_login_at)}</td><td>{u.active ? <span className="badge success">نشط</span> : <span className="badge">موقوف</span>}</td></tr>)}</tbody></table>
          )}
        </div>
      )}
      {tab === 'roles' && (
        <div className="grid grid-3">
          {(roles.data ?? []).map((r) => (
            <div key={r.id} className="card pad clickable" style={{ cursor: r.code === 'admin' ? 'default' : 'pointer' }} onClick={() => r.code !== 'admin' && setEditRole(r)}>
              <div className="row"><Shield size={18} color="var(--primary)" /><h3>{r.name}</h3><div className="grow" /><span className="badge">{r.user_count} مستخدم</span></div>
              <div className="small muted mt">{r.permissions === '*' ? 'كل الصلاحيات' : `${r.permissions.length} صلاحية`}{r.is_system ? ' • دور أساسي' : ''}</div>
            </div>
          ))}
        </div>
      )}
      {editUser && <UserDialog user={editUser} roles={roles.data ?? []} onClose={() => { setEditUser(null); void users.refetch(); void quota.refetch(); }} />}
      {editRole && <RoleDialog role={editRole} onClose={() => { setEditRole(null); void roles.refetch(); }} />}
    </div>
  );
}

function UserDialog({ user, roles, onClose }: { user: any; roles: any[]; onClose: () => void }) {
  const { run, busy } = useAction();
  const [f, setF] = useState({ username: user.username ?? '', fullName: user.full_name ?? '', password: '', roleId: user.role_id ?? roles.find((r) => r.code === 'cashier')?.id, maxDiscountPct: user.max_discount_pct ?? null, active: user.active ?? 1 });
  return (
    <Modal title={user.id ? `تعديل ${user.full_name}` : 'مستخدم جديد'} onClose={onClose} footer={<button className="btn primary" disabled={busy} onClick={() => run(async () => {
      await api('users.save', { id: user.id ?? null, data: { username: f.username, fullName: f.fullName, password: f.password || undefined, roleId: f.roleId, maxDiscountPct: f.maxDiscountPct, active: !!f.active } });
      onClose();
    }, 'تم الحفظ')}>حفظ</button>}>
      <div className="form-grid">
        <Field label="الاسم"><input className="input" autoFocus value={f.fullName} onChange={(e) => setF({ ...f, fullName: e.target.value })} /></Field>
        <Field label="اسم الدخول"><input className="input" dir="ltr" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} /></Field>
        <Field label={user.id ? 'كلمة مرور جديدة (اتركها فارغة بدون تغيير)' : 'كلمة المرور'}><input className="input" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></Field>
        <Field label="الدور"><select className="select" value={f.roleId} onChange={(e) => setF({ ...f, roleId: Number(e.target.value) })}>{roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select></Field>
        <Field label="أقصى خصم بدون موافقة %" help="فارغ = إعداد المحل العام"><NumberInput value={f.maxDiscountPct} allowEmpty onChange={(v) => setF({ ...f, maxDiscountPct: v })} /></Field>
        {user.id && <label className="check"><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked ? 1 : 0 })} /> نشط (إلغاء التحديد يوقف المستخدم عن الدخول دون حذف سجله)</label>}
      </div>
    </Modal>
  );
}

function RoleDialog({ role, onClose }: { role: any; onClose: () => void }) {
  const { run, busy } = useAction();
  const [name, setName] = useState(role.name ?? '');
  const [perms, setPerms] = useState<string[]>(role.permissions === '*' ? Object.keys(PERMISSIONS) : role.permissions ?? []);
  const toggle = (p: string) => setPerms((x) => (x.includes(p) ? x.filter((y) => y !== p) : [...x, p]));
  return (
    <Modal title={role.id ? `صلاحيات: ${role.name}` : 'دور جديد'} size="lg" onClose={onClose} footer={<>
      {role.id && !role.is_system && <button className="btn danger outline" onClick={() => run(async () => { await api('roles.delete', { id: role.id }); onClose(); })}>حذف الدور</button>}
      <div className="grow" /><button className="btn primary" disabled={busy || !name.trim()} onClick={() => run(async () => { await api('roles.save', { id: role.id ?? null, data: { name, permissions: perms } }); onClose(); }, 'تم الحفظ')}>حفظ</button></>}>
      <div className="col">
        <Field label="اسم الدور"><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid grid-2">
          {PERMISSION_GROUPS.map((g) => (
            <div key={g.label} className="card pad">
              <div className="row mb"><b>{g.label}</b><div className="grow" /><button className="btn ghost sm" onClick={() => setPerms((x) => (g.keys.every((k) => x.includes(k)) ? x.filter((k) => !g.keys.includes(k as never)) : [...new Set([...x, ...g.keys])]))}>الكل</button></div>
              <div className="col gap-sm">{g.keys.map((k) => <label key={k} className="check small"><input type="checkbox" checked={perms.includes(k)} onChange={() => toggle(k)} /> {PERMISSIONS[k]}</label>)}</div>
            </div>
          ))}
        </div>
      </div>
    </Modal>
  );
}
