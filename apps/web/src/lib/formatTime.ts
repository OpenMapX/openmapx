/** Format an ISO timestamp to a short HH:MM time string using the given locale. */
export function formatTime(iso: string, locale?: string): string {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale ?? [], { hour: "2-digit", minute: "2-digit" });
}
