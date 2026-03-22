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
