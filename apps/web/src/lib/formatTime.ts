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
