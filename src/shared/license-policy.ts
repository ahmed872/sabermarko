/**
 * Commercial policy derived from the license. Business logic never hardcodes
 * these numbers: it receives `maxUsers` (and future feature flags) from here.
 *
 * Backward compatibility: keys issued before editions existed carry no
 * `edition`/`maxUsers` and get DEFAULT_MAX_USERS — they keep working unchanged.
 */
export type Edition = 'basic' | 'standard' | 'professional';

export const EDITIONS: Record<Edition, { label: string; maxUsers: number }> = {
  basic: { label: 'الباقة الأساسية', maxUsers: 2 },
  standard: { label: 'الباقة القياسية', maxUsers: 5 },
  professional: { label: 'الباقة الاحترافية', maxUsers: 15 },
};

/** Trial installs and legacy licenses without an explicit limit. */
export const DEFAULT_MAX_USERS = 10;
/** Absolute safety cap regardless of what a key says. */
export const HARD_MAX_USERS = 100;

export interface LicenseLimits { maxUsers: number; edition: Edition | null; editionLabel: string | null }

export function limitsFrom(payload: { maxUsers?: number | null; edition?: string | null } | null | undefined): LicenseLimits {
  const edition = payload?.edition && payload.edition in EDITIONS ? (payload.edition as Edition) : null;
  let maxUsers = DEFAULT_MAX_USERS;
  if (edition) maxUsers = EDITIONS[edition].maxUsers;
  if (typeof payload?.maxUsers === 'number' && Number.isInteger(payload.maxUsers) && payload.maxUsers > 0) maxUsers = payload.maxUsers;
  return { maxUsers: Math.min(maxUsers, HARD_MAX_USERS), edition, editionLabel: edition ? EDITIONS[edition].label : null };
}
