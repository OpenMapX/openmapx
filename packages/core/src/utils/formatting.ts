export function getInitials(name: string | null | undefined, email: string): string {
  if (name) {
    return name
      .split(" ")
      .map((n) => n[0])
      .join("")
      .toUpperCase()
      .slice(0, 2);
  }
  return email[0].toUpperCase();
}

/**
 * Format a distance in metres to a human-readable string.
 * < 1000 m → "850 m"
 * ≥ 1000 m → "1.2 km"
 */
export function formatDistance(metres: number): string {
  if (metres < 1000) return `${Math.round(metres)} m`;
  return `${(metres / 1000).toFixed(1)} km`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * < 60 s  → "45 sec"
 * < 3600  → "12 min"
 * ≥ 3600  → "1 h 23 min"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}
