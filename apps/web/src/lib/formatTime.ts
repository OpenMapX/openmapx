/** Format an ISO timestamp to a short HH:MM time string using the given locale. */
export function formatTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale ?? [], { hour: "2-digit", minute: "2-digit" });
}

/** Format a millisecond duration as a human-readable relative time string (e.g. "5m ago"). */
export function relativeTime(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const days = Math.floor(hr / 24);
  return `${days}d ago`;
}

/**
 * Format an ISO timestamp as a coarse relative time for admin/activity views:
 * "just now", "5m ago", "3h ago", otherwise the locale date string.
 */
export function relativeTimeFromIso(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return new Date(iso).toLocaleDateString();
}
