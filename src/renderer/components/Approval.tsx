import { useEffect, useState, type ReactNode } from 'react';
import { ShieldCheck } from 'lucide-react';
import { registerApprovalPrompt } from '../lib/api';
import { PERMISSIONS } from '../../shared/permissions';
import { Field, Modal } from './ui';

/** Supervisor override: a manager types their credentials to approve one action. */
export function ApprovalProvider({ children }: { children: ReactNode }) {
  const [req, setReq] = useState<{ permission: string; resolve: (v: { username: string; password: string } | null) => void } | null>(null);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    registerApprovalPrompt((permission) => new Promise((resolve) => { setUsername(''); setPassword(''); setReq({ permission, resolve }); }));
  }, []);
  if (!req) return <>{children}</>;
  const done = (v: { username: string; password: string } | null) => { req.resolve(v); setReq(null); };
  const label = (PERMISSIONS as Record<string, string>)[req.permission] ?? 'عملية حساسة';
  return (
    <>
      {children}
      <Modal title="موافقة مدير" size="sm" icon={<ShieldCheck color="var(--primary)" />} onClose={() => done(null)}
        footer={<><button className="btn" onClick={() => done(null)}>إلغاء</button><button className="btn primary" disabled={!username || !password} onClick={() => done({ username, password })}>موافقة</button></>}>
        <form className="col" onSubmit={(e) => { e.preventDefault(); if (username && password) done({ username, password }); }}>
          <div className="alert info">هذه العملية تحتاج موافقة مستخدم لديه صلاحية: <b>{label}</b></div>
          <Field label="اسم مستخدم المدير"><input className="input" autoFocus value={username} onChange={(e) => setUsername(e.target.value)} /></Field>
          <Field label="كلمة المرور"><input className="input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <button type="submit" hidden />
        </form>
      </Modal>
    </>
  );
}
