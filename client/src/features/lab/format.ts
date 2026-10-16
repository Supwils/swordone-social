/** Number and date formatting shared by every lab panel (Era 2 and Era 3). */
const DASH = '—';

export const finite = (v: number | null | undefined): v is number =>
  typeof v === 'number' && Number.isFinite(v);

/** Similarities, slopes and SDs: 3 decimals by default; null/NaN render as a dash. */
export function fmtNum(v: number | null | undefined, digits = 3): string {
  return finite(v) ? v.toFixed(digits) : DASH;
}

/** Shares and rates: a percentage with one decimal. */
export function fmtPct(v: number | null | undefined): string {
  return finite(v) ? `${(v * 100).toFixed(1)}%` : DASH;
}

/** Observed ÷ expected. */
export function fmtRatio(v: number | null | undefined): string {
  return finite(v) ? `${v.toFixed(2)}×` : DASH;
}

/** ISO instant → `YYYY-MM-DD`, the convention every lab panel uses. */
export function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : DASH;
}
