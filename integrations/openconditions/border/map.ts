import type {
  BorderCrossing,
  BorderCrossingMode,
  BorderCrossingProgram,
  BorderCrossingQueue,
  BorderWaitStatus,
} from "@openmapx/integration-framework";
import {
  allowedReadings,
  type CreditSources,
  credit,
  firstText,
  instantOf,
  itemIdOf,
  keyPrefixesOf,
  type LatestReading,
  list,
  NO_SOURCES,
  newestReading,
  noticeCredits,
  pointOf,
  type Rec,
  rec,
  sourcesOf,
  splitKey,
  str,
  upstreamCredits,
} from "../features/record.js";

/** How long a stated wait stays current: the freshness window of `border.wait`. */
export const WAIT_FRESH_MS = 7_200_000;
/** How long a crossing's stated open status stays current: the window of `facility.open_status`. */
export const OPEN_STATUS_FRESH_MS = 86_400_000;

const MODES: ReadonlySet<string> = new Set<BorderCrossingMode>([
  "commercial",
  "passenger",
  "pedestrian",
  "bus",
  "rail",
]);
const PROGRAMS: ReadonlySet<string> = new Set<BorderCrossingProgram>([
  "standard",
  "fast",
  "trusted_traveller",
  "ready_lane",
]);
const WAIT_STATUSES: ReadonlySet<string> = new Set<BorderWaitStatus>([
  "no_delay",
  "delay",
  "closed",
  "unknown",
]);
const COUNTRY = /^[A-Z]{2}$/;

function oneOf<T extends string>(set: ReadonlySet<string>, value: unknown): T | undefined {
  return typeof value === "string" && set.has(value) ? (value as T) : undefined;
}

const country = (value: unknown): string | undefined =>
  typeof value === "string" && COUNTRY.test(value) ? value : undefined;

const count = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;

/** Whether a reading is current at `now`: stated within `freshMs`, and not past its validity. */
function current(reading: LatestReading, now: number, freshMs: number): boolean {
  const until = reading.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);
  if (Number.isFinite(until) && until < now) return false;
  const at = instantOf(reading.phenomenonTime);
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) && now - ms <= freshMs;
}

/**
 * An OpenConditions `border_crossing` record with its readings in effect as
 * a border crossing. Each `lane_group` component is a queue, in the
 * direction its details state, with the newest `border.wait` reading about
 * it; a canonical crossing lists the queues of every agency that publishes
 * one way across it. A queue without a current wait reads `unknown` and
 * stale, keeping a stale reading's last stated wait. The crossing is open
 * or closed as a current `facility.open_status` reading states it.
 *
 * Every source `excluded` holds is taken out: its credit, its readings and
 * the queues it published. Null when the record is no placeable crossing or
 * its survivor is excluded: the name and place are the survivor's.
 */
export function recordToBorderCrossing(
  record: Rec,
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean = () => false,
  sources: CreditSources = NO_SOURCES,
  now: Date = new Date(),
): BorderCrossing | null {
  const id = itemIdOf(record);
  const location = rec(record.location);
  const coordinates = pointOf(location);
  if (!id || record.kind !== "border_crossing" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0];
  if (survivor === undefined || excluded(survivor.id)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const prefixes = keyPrefixesOf(
    record,
    all.map((s) => s.id),
  );
  const readings = allowedReadings(latest, excluded);
  const at = now.getTime();

  const queues: BorderCrossingQueue[] = [];
  for (const component of list(record.components)) {
    const key = str(component.key);
    if (component.kind !== "lane_group" || !key) continue;
    const owner = splitKey(key, prefixes).source ?? survivor.id;
    if (excluded(owner)) continue;
    const details = rec(component.details);
    const mode = oneOf<BorderCrossingMode>(MODES, details.mode);
    if (!mode) continue;
    const program = oneOf<BorderCrossingProgram>(PROGRAMS, details.program);
    const direction = rec(details.direction);
    const from = country(direction.from);
    const to = country(direction.to);
    const reading = newestReading(readings, "border.wait", key);
    const value = rec(rec(reading?.result).value);
    const status = oneOf<BorderWaitStatus>(WAIT_STATUSES, value.status);
    const waitMinutes = count(value.waitMinutes);
    const lanesOpen = count(value.lanesOpen);
    const updatedAt = reading ? instantOf(reading.phenomenonTime) : undefined;
    const fresh = reading !== undefined && current(reading, at, WAIT_FRESH_MS);
    queues.push({
      key,
      mode,
      ...(program ? { program } : {}),
      ...(from ? { from } : {}),
      ...(to ? { to } : {}),
      status: status ?? "unknown",
      ...(waitMinutes !== undefined ? { waitMinutes } : {}),
      ...(lanesOpen !== undefined ? { lanesOpen } : {}),
      ...(updatedAt ? { updatedAt } : {}),
      stale: !fresh,
    });
  }

  const openReading = newestReading(readings, "facility.open_status", undefined);
  const openValue =
    openReading && current(openReading, at, OPEN_STATUS_FRESH_MS)
      ? rec(openReading.result).value
      : undefined;
  const open = openValue === "open" || openValue === "closed" ? openValue : undefined;
  const countries = Array.isArray(rec(record.details).countries)
    ? (rec(record.details).countries as unknown[]).flatMap((c) => country(c) ?? [])
    : [];
  const name = firstText(record.name);
  const where = firstText(location.areaDescription);
  const hours = str(rec(record.openingHours).osm);
  return {
    id,
    name: name ?? "",
    coordinates,
    countries,
    ...(where ? { location: where } : {}),
    ...(open ? { open } : {}),
    ...(hours ? { openingHours: hours } : {}),
    queues,
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, sources)),
      ...upstreamCredits(kept, sources),
      ...noticeCredits(kept, sources),
    ],
  };
}
