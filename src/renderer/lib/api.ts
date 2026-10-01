import { errorMessage, type AppErrorPayload } from '../../shared/errors';

declare global {
  interface Window {
    sbm: { invoke: (channel: string, payload?: unknown) => Promise<{ ok: true; data: unknown } | { ok: false; error: AppErrorPayload }>; platform: string };
  }
}

export class ApiError extends Error {
  code: string;
  params?: Record<string, string | number>;
  constructor(e: AppErrorPayload) {
    super(errorMessage(e.code, e.params));
    this.code = e.code;
    this.params = e.params;
  }
}

type ApprovalPrompt = (permission: string, message: string) => Promise<{ username: string; password: string } | null>;
let approvalPrompt: ApprovalPrompt | null = null;
let onAuthLost: (() => void) | null = null;
let onLicenseLost: (() => void) | null = null;

export function registerApprovalPrompt(fn: ApprovalPrompt) { approvalPrompt = fn; }
export function registerAuthLost(fn: () => void) { onAuthLost = fn; }
export function registerLicenseLost(fn: () => void) { onLicenseLost = fn; }

/** Call the main process. Throws ApiError with an Arabic message on failure. */
export async function api<T = any>(channel: string, payload?: unknown): Promise<T> {
  const res = await window.sbm.invoke(channel, payload);
  if (res.ok) return res.data as T;
  const err = new ApiError(res.error);
  if (err.code === 'NOT_AUTHENTICATED') onAuthLost?.();
  if (err.code === 'LICENSE_REQUIRED' || err.code === 'CLOCK_TAMPERED') onLicenseLost?.();
  throw err;
}

/**
 * Like api(), but when the action needs a manager's approval, asks for the
 * manager's credentials and retries once with them (supervisor override).
 */
export async function apiApproved<T = any>(channel: string, payload: Record<string, unknown> = {}): Promise<T> {
  try {
    return await api<T>(channel, payload);
  } catch (e) {
    if (!(e instanceof ApiError) || e.code !== 'APPROVAL_REQUIRED' || !approvalPrompt) throw e;
    const creds = await approvalPrompt(String(e.params?.permission ?? ''), e.message);
    if (!creds) throw new ApiError({ code: 'APPROVAL_REQUIRED', params: e.params });
    return api<T>(channel, { ...payload, __approval: creds });
  }
}
