const TASHKEEL = /[ؐ-ًؚ-ٰٟۖ-ۭـ]/g;
const ARABIC_INDIC = '٠١٢٣٤٥٦٧٨٩';
const PERSIAN = '۰۱۲۳۴۵۶۷۸۹';

/** Convert Arabic-Indic / Persian digits to Latin digits. */
export function latinDigits(s: string): string {
  let out = '';
  for (const ch of s) {
    const a = ARABIC_INDIC.indexOf(ch);
    if (a >= 0) { out += String(a); continue; }
    const p = PERSIAN.indexOf(ch);
    if (p >= 0) { out += String(p); continue; }
    if (ch === '٫') { out += '.'; continue; }
    out += ch;
  }
  return out;
}

/**
 * Normalize Arabic text for searching: removes diacritics/tatweel,
 * unifies alef/yaa/taa-marbuta/hamza forms, lowercases latin, unifies digits.
 */
export function normalizeArabic(input: string | null | undefined): string {
  if (!input) return '';
  return latinDigits(String(input))
    .replace(TASHKEEL, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Parse a user-entered decimal number that may contain Arabic digits/commas. */
export function parseDecimal(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') return Number.isFinite(input) ? input : null;
  const s = latinDigits(input).replace(/[,،\s]/g, '').replace('٫', '.');
  if (s === '' || s === '.' || s === '-') return null;
  if (!/^-?\d*\.?\d*$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/** Initials for an avatar generated from the store name. */
export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);
  const skip = new Set(['سوبر', 'ماركت', 'محل', 'محلات', 'بقالة', 'ال']);
  const meaningful = words.filter((w) => !skip.has(w));
  const pick = (meaningful.length ? meaningful : words).slice(0, 2);
  return pick.map((w) => w.replace(/^ال/, '').charAt(0)).join(' ').trim() || '؟';
}
