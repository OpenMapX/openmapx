// Timezone helpers for time-aware closure routing. `Intl`-based (no dependency).
// Used to (a) resolve a user's wall-clock departure into an absolute instant in
// the route origin's zone, and (b) evaluate a closure's recurring schedule in
// the closure's own `scheduleTimezone` — both DST-correct.

/** Minutes `timeZone` is ahead of UTC at the given instant (DST-aware). */
function tzOffsetMinutes(timeZone: string, utcMs: number): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(new Date(utcMs));
  const tz = parts.find((p) => p.type === "timeZoneName")?.value ?? "GMT+0";
  const m = tz.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!m) return 0;
  return (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
}

/**
 * Resolve a wall-clock "YYYY-MM-DDTHH:mm[:ss]" interpreted in `timeZone` to an
 * absolute instant, DST-aware (treats the parts as local, then subtracts the
 * zone's offset at that instant). Returns null when unparseable.
 */
export function zonedWallClockToInstant(timeZone: string, wallClock: string): Date | null {
  const m = wallClock.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/);
  if (!m) return null;
  let ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  ms -= tzOffsetMinutes(timeZone, ms) * 60_000;
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Local calendar date ("YYYY-MM-DD") of an instant in `timeZone`. */
export function localDateInZone(at: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}
