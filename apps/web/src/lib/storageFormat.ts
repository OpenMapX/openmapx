const UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number, fractionDigits = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const idx = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), UNITS.length - 1);
  const value = bytes / 1024 ** idx;
  const fmt = idx === 0 ? value.toFixed(0) : value.toFixed(fractionDigits);
  return `${fmt} ${UNITS[idx]}`;
}
