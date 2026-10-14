import type {
  MessageSign,
  MessageSignStatus,
  MessageSignType,
} from "@openmapx/integration-framework";
import {
  allowedReadings,
  CROWD_CREDIT,
  type CreditSources,
  countryOf,
  credit,
  crowdReported,
  firstText,
  itemIdOf,
  type LatestReading,
  list,
  NO_SOURCES,
  newestReading,
  pointOf,
  type Rec,
  rec,
  sourcesOf,
  str,
  upstreamCredits,
} from "../features/record.js";

const SIGN_TYPES: ReadonlySet<string> = new Set<MessageSignType>([
  "textual",
  "pictogram",
  "matrix",
  "lane_control",
  "hybrid",
  "arrow_board",
  "flashing_beacon",
  "other",
]);
const SIGN_STATUSES: ReadonlySet<string> = new Set<MessageSignStatus>([
  "in_service",
  "out_of_service",
  "fault",
  "blank",
  "unknown",
]);
const COMPASS: ReadonlySet<string> = new Set(["N", "NE", "E", "SE", "S", "SW", "W", "NW"]);

function oneOf<T extends string>(set: ReadonlySet<string>, value: unknown): T | undefined {
  return typeof value === "string" && set.has(value) ? (value as T) : undefined;
}

/** A message's pages as text lines: each line is a Text, its first language's text taken. */
function pagesOf(value: Rec): string[][] {
  return list(value.messages).flatMap((message) =>
    list(message.text).flatMap((page) => {
      const lines = (Array.isArray(page.lines) ? page.lines : []).flatMap((line) => {
        const text = firstText(line);
        return text ? [text] : [];
      });
      return lines.length > 0 ? [lines] : [];
    }),
  );
}

/**
 * One canonical OpenConditions `vms` feature with its newest `vms.display`
 * reading as a `MessageSign`; null for a record without an id or a point, or
 * whose surviving source is excluded. A sign has one face (`0`) in every
 * feed read today; the reading of the face the record names first stands.
 * A reading from an excluded source is not shown: the sign then shows its
 * place and an unknown status.
 */
export function recordToMessageSign(
  record: Rec,
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean = () => false,
  sources: CreditSources = NO_SOURCES,
): MessageSign | null {
  const id = itemIdOf(record);
  const location = rec(record.location);
  const coordinates = pointOf(location);
  if (!id || record.kind !== "vms" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0];
  if (survivor === undefined || excluded(survivor.id)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const readings = allowedReadings(latest, excluded);
  const face =
    list(record.components)
      .filter((c) => c.kind === "sign_face")
      .map((c) => str(c.key))
      .find(Boolean) ?? "0";
  const reading = newestReading(readings, "vms.display", face);
  const value = rec(rec(reading?.result).value);
  const status =
    (reading && oneOf<MessageSignStatus>(SIGN_STATUSES, value.workingStatus)) || "unknown";
  const updatedAt = str(rec(reading?.phenomenonTime).instant);

  const name = firstText(record.name);
  const where = firstText(record.description);
  const road = list(location.roads)
    .map((r) => firstText(r.name) ?? str(r.ref))
    .find(Boolean);
  const compass = str(rec(location.direction).compass);
  const country = countryOf(location);
  const operatorName = firstText(rec(record.operator).name);
  return {
    id,
    name: name ?? "",
    type: oneOf<MessageSignType>(SIGN_TYPES, record.type) ?? "other",
    ...(country ? { country } : {}),
    coordinates,
    ...(where ? { location: where } : {}),
    ...(road ? { road } : {}),
    ...(compass && COMPASS.has(compass) ? { direction: compass as MessageSign["direction"] } : {}),
    ...(operatorName ? { operator: { name: operatorName } } : {}),
    status,
    pages: status === "in_service" ? pagesOf(value) : [],
    ...(updatedAt ? { updatedAt } : {}),
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, sources)),
      ...upstreamCredits(kept, sources),
      ...(crowdReported(reading) ? [CROWD_CREDIT] : []),
    ],
  };
}
