import type { FuelStation } from "@openmapx/integration-framework";
import { licenseUrlForSpdx } from "@openmapx/mobility-core/license";

/**
 * What every OpenConditions feature domain reads the same way: a canonical
 * record's sources and their credits, its member ids and component-key
 * prefixes, its location, and its latest readings.
 */

export type Rec = Record<string, unknown>;

/** A credit as every feature contract carries it. */
export type Attribution = FuelStation["attributions"][number];

/** One latest reading of a feature as `expand=latest` serves it. */
export interface LatestReading {
  property: string;
  componentKey?: string;
  result: unknown;
  phenomenonTime: unknown;
  /** The instant the reading stops being current, when it has one. */
  validUntil?: string;
  /**
   * A feed id, or for a reading fused from `contributors` `@fused` (every
   * source; all public in public scope) or `@fused-public` (the public sources
   * of a fusion that also used a non-public one).
   */
  source: string;
  contributors?: string[];
}

const FUSED = new Set(["@fused", "@fused-public"]);

/** The contributor id OpenConditions gives its own crowd reports. */
export const CROWD = "crowd";

/**
 * The credit of the OpenConditions instance's community reports. They are no
 * feed, so `/sources` never lists them; they are public in every scope.
 */
export const CROWD_CREDIT: Attribution = {
  sourceId: CROWD,
  name: "OpenConditions community reports",
  url: "https://openconditions.org",
};

export function rec(value: unknown): Rec {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Rec) : {};
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function list(value: unknown): Rec[] {
  return Array.isArray(value) ? value.map(rec) : [];
}

/** The first text of a multilingual `[{ lang, text }]` value. */
export function firstText(value: unknown): string | undefined {
  return list(value)
    .map((t) => str(t["text"]))
    .find(Boolean);
}

/**
 * A source of the record, the credit it carries and the upstream publishers
 * its member took the record from, survivor first.
 */
export interface RecordSource {
  id: string;
  attribution: Rec;
  upstream: Rec[];
}

export function sourcesOf(record: Rec): RecordSource[] {
  const provenance = rec(record["provenance"]);
  const out: RecordSource[] = [];
  const add = (id: unknown, attribution: unknown, upstream: unknown) => {
    const sourceId = str(id);
    if (!sourceId) return;
    const held = out.find((s) => s.id === sourceId);
    if (held) held.upstream.push(...list(upstream));
    else out.push({ id: sourceId, attribution: rec(attribution), upstream: list(upstream) });
  };
  add(provenance["sourceId"], provenance["attribution"], provenance["upstream"]);
  for (const merged of list(provenance["mergedSources"])) {
    add(merged["source"], merged["attribution"], merged["upstream"]);
  }
  return out;
}

/** The ids of the records a canonical feature was built from: its members and merged records. */
export function memberIdsOf(record: Rec): string[] {
  const provenance = rec(record["provenance"]);
  const ids = [
    ...list(rec(provenance["derivedFrom"])["records"]).map((r) => r["id"]),
    ...list(provenance["mergedSources"]).map((m) => m["recordId"]),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

/**
 * The id a feature is known by: its survivor member's feature id
 * (`oc:feature:<feed>:<station>`), which stays while the cluster gains or
 * loses members; a canonical id changes with them. A record that is no
 * canonical feature keeps its own id.
 */
export function itemIdOf(record: Rec): string | undefined {
  const provenance = rec(record["provenance"]);
  const sourceId = str(provenance["sourceId"]);
  const recordId = str(provenance["recordId"]);
  const survivor = sourceId && recordId ? `oc:feature:${sourceId}:${recordId}` : undefined;
  return survivor !== undefined && memberIdsOf(record).includes(survivor)
    ? survivor
    : str(record["id"]);
}

/** The sources behind a reading: its own, or every contributor of a fused one. */
export function readingSources(reading: LatestReading): string[] {
  return FUSED.has(reading.source) ? (reading.contributors ?? []) : [reading.source];
}

/** The feeds behind a reading, which must be listed and not excluded; crowd reports are none. */
export function readingFeeds(reading: LatestReading): string[] {
  return readingSources(reading).filter((id) => id !== CROWD);
}

/** Whether crowd reports contributed to a reading. */
export function crowdReported(reading: LatestReading | undefined): boolean {
  return reading !== undefined && readingSources(reading).includes(CROWD);
}

export function instantOf(time: unknown): string | undefined {
  const t = rec(time);
  return str(t["instant"]) ?? str(t["end"]) ?? str(t["start"]);
}

/** When a reading was observed, in epoch milliseconds; -Infinity when it does not say. */
function observedAt(reading: LatestReading): number {
  const at = instantOf(reading.phenomenonTime);
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * The reading of `property` about `componentKey` (undefined: the feature
 * itself) in effect. Where fusion has not run, OpenConditions serves each
 * member's reading of a component; the newest observation is the one in
 * effect.
 */
export function newestReading(
  readings: readonly LatestReading[],
  property: string,
  componentKey: string | undefined,
): LatestReading | undefined {
  return readings
    .filter((r) => r.property === property && r.componentKey === componentKey)
    .reduce<LatestReading | undefined>(
      (newest, r) => (newest === undefined || observedAt(r) > observedAt(newest) ? r : newest),
      undefined,
    );
}

/**
 * The readings that may be shown when `excluded` sources are taken out. A
 * fused reading is one value OpenConditions computed from all its
 * contributors; the excluded source's share cannot be taken out of it, so the
 * whole reading goes, even when an allowed contributor agreed with it.
 */
export function allowedReadings(
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean,
): LatestReading[] {
  return latest.filter((r) => !readingFeeds(r).some(excluded));
}

/** A source's link by source id, from the live data sources. */
export type SourceLink = (sourceId: string) => string | undefined;

export const noLink: SourceLink = () => undefined;

/** A source's credit; without a link of its own it takes the source's link from `linkOf`. */
export function credit(source: RecordSource, linkOf: SourceLink): Attribution {
  const a = source.attribution;
  const url = str(a["url"]) ?? linkOf(source.id);
  const license = str(a["license"]);
  const licenseUrl = str(a["licenseUrl"]);
  return {
    sourceId: source.id,
    name: str(a["provider"]) ?? source.id,
    ...(url ? { url } : {}),
    ...(license ? { spdxLicense: license } : {}),
    ...(licenseUrl ? { licenseUrl } : {}),
  };
}

/**
 * The credits of the upstream publishers the aggregators among the kept
 * sources took the feature from: one per publisher, named "<feed provider> –
 * <publisher>" under the feed it came through, with the licence's own text
 * linked where the publisher states one. A publisher is owed credit whatever
 * its licence, so one without a licence is credited by name.
 */
export function upstreamCredits(kept: readonly RecordSource[], linkOf: SourceLink): Attribution[] {
  const out: Attribution[] = [];
  for (const source of kept) {
    const feed = credit(source, linkOf);
    for (const u of source.upstream) {
      const publisher = str(u["publisher"]);
      if (!publisher) continue;
      const license = str(u["license"]);
      const name = `${feed.name} – ${publisher}`;
      if (out.some((a) => a.sourceId === source.id && a.name === name)) continue;
      const licenseUrl = license ? licenseUrlForSpdx(license) : undefined;
      out.push({
        sourceId: source.id,
        name,
        ...(feed.url ? { url: feed.url } : {}),
        ...(license ? { spdxLicense: license } : {}),
        ...(licenseUrl ? { licenseUrl } : {}),
        publisher: { name: publisher },
      });
    }
  }
  return out;
}

export function addressOf(location: Rec): string | undefined {
  const address = rec(location["address"]);
  const street = [str(address["street"]), str(address["houseNumber"])].filter(Boolean).join(" ");
  const place = [str(address["postalCode"]), str(address["city"])].filter(Boolean).join(" ");
  const line = [street, place].filter(Boolean).join(", ");
  return line.length > 0 ? line : undefined;
}

export function countryOf(location: Rec): string | undefined {
  const country =
    str(rec(location["address"])["country"]) ?? str(rec(location["admin"])["country"]);
  return country && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined;
}

export function pointOf(location: Rec): [number, number] | undefined {
  const geometry = rec(location["geometry"]);
  const coordinates = geometry["coordinates"];
  if (geometry["type"] !== "Point" || !Array.isArray(coordinates)) return undefined;
  const [lon, lat] = coordinates;
  return typeof lon === "number" && typeof lat === "number" ? [lon, lat] : undefined;
}

/** A prefix a canonical component key may carry, and the source whose component it marks. */
export interface KeyPrefix {
  prefix: string;
  source: string;
}

const FEATURE_ID = /^oc:feature:([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?):(.+)$/;

/**
 * The prefixes a canonical feature keys a merged member's own components
 * under: `<sourceId>/`, or `<localId>/` of the member record when another
 * component already took `<sourceId>/<key>`. A member's local id counts only
 * when the record's namespace is one of the feature's sources.
 */
export function keyPrefixesOf(record: Rec, sourceIds: readonly string[]): KeyPrefix[] {
  const locals = memberIdsOf(record).flatMap((memberId) => {
    const [, namespace, localId] = FEATURE_ID.exec(memberId) ?? [];
    return namespace && localId && sourceIds.includes(namespace)
      ? [{ prefix: localId, source: namespace }]
      : [];
  });
  return [...sourceIds.map((id) => ({ prefix: id, source: id })), ...locals];
}

/** The member's own key of a component key and the source it marks, when a prefix marks one. */
export function splitKey(
  key: string,
  prefixes: readonly KeyPrefix[],
): { source?: string; key: string } {
  const owner = prefixes.find(({ prefix }) => key.startsWith(`${prefix}/`));
  return owner ? { source: owner.source, key: key.slice(owner.prefix.length + 1) } : { key };
}
