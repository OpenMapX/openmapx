const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

/** A byte count in binary units, with the decimal separator of `locale`. */
export function formatBytes(bytes: number, locale: string, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return `0 ${UNITS[0]}`;
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const digits = idx === 0 ? 0 : fractionDigits;
  const value = new Intl.NumberFormat(locale, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(bytes / 1024 ** idx);
  return `${value} ${UNITS[idx]}`;
}
