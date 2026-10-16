import type { FuelStation } from "@openmapx/integration-framework";
import {
  readCapturedContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import {
  canonicalLicenseExpression,
  isSafeAttributionUrl,
  type LicenseDescriptor,
  type Licensing,
  licensingLinks,
  parseLicensing,
} from "@openmapx/mobility-core/licensing";

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
  /** Immutable, privacy-safe credit snapshot of this selected observation. */
  provenance?: {
    sourceId: string;
    attribution: Rec;
    upstream?: Rec[];
    mergedSources?: Rec[];
  };
}

const FUSED = new Set(["@fused", "@fused-public"]);

/**
 * The contributor id OpenConditions gives its own crowd reports. They are no
 * feed: `/sources` states their credit beside the feeds, and they are public
 * in every scope.
 */
export const CROWD = "crowd";

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
    .map((t) => str(t.text))
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
  const provenance = rec(record.provenance);
  const out: RecordSource[] = [];
  const seen = new Set<string>();
  const add = (id: unknown, attribution: unknown, upstream: unknown) => {
    const sourceId = str(id);
    if (!sourceId) return;
    const captured = { id: sourceId, attribution: rec(attribution), upstream: list(upstream) };
    // Identity selects/filter sources; it cannot collapse different acquisition notices.
    const key = JSON.stringify(captured);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(structuredClone(captured));
    }
  };
  add(provenance.sourceId, provenance.attribution, provenance.upstream);
  for (const merged of list(provenance.mergedSources)) {
    add(merged.source, merged.attribution, merged.upstream);
  }
  return out;
}

/** The ids of the records a canonical feature was built from: its members and merged records. */
export function memberIdsOf(record: Rec): string[] {
  const provenance = rec(record.provenance);
  const ids = [
    ...list(rec(provenance.derivedFrom).records).map((r) => r.id),
    ...list(provenance.mergedSources).map((m) => m.recordId),
  ];
  return [...new Set(ids.filter((id): id is string => typeof id === "string"))];
}

/**
 * The id a feature is known by: its survivor member's feature id
 * (`oc:feature:<feed>:<station>`), which stays while the cluster gains or
 * loses members; a canonical id changes with them. A record that is no
 * canonical feature keeps its own id.
 *
 * Some feeds build the feature id from the record id with every character
 * outside `[A-Za-z0-9._:-]` replaced by `_` (an OSM camera's `node/701` is
 * `node_701`), others keep it as is. The survivor's id is whichever of the
 * two forms is actually a member, the record id as is first.
 */
export function itemIdOf(record: Rec): string | undefined {
  const provenance = rec(record.provenance);
  const sourceId = str(provenance.sourceId);
  const recordId = str(provenance.recordId);
  if (sourceId && recordId) {
    const members = memberIdsOf(record);
    const forms = [recordId, recordId.replace(/[^A-Za-z0-9._:-]/g, "_")];
    const survivor = forms
      .map((form) => `oc:feature:${sourceId}:${form}`)
      .find((id) => members.includes(id));
    if (survivor !== undefined) return survivor;
  }
  return str(record.id);
}

/** The sources behind a reading: its own, or every contributor of a fused one. */
export function readingSources(reading: LatestReading): string[] {
  return FUSED.has(reading.source) ? (reading.contributors ?? []) : [reading.source];
}

/** The feeds behind a reading, which must be listed and not excluded; crowd reports are none. */
export function readingFeeds(reading: LatestReading): string[] {
  return readingSources(reading).filter((id) => id !== CROWD);
}

export function instantOf(time: unknown): string | undefined {
  const t = rec(time);
  return str(t.instant) ?? str(t.end) ?? str(t.start);
}

/**
 * The properties OpenConditions keeps only the changes of (`retention.changeOnly`
 * in its model: model-weather, model-facilities and model-roads). A reading of
 * one is written once per change, so its `phenomenonTime` is when the value
 * last changed, however long ago; OpenConditions serves it with the
 * `validUntil` its source's polling gives it (`withPolledValidity`).
 */
export const CHANGE_ONLY_PROPERTIES: ReadonlySet<string> = new Set([
  "weather.precipitation_type",
  "road.surface_state",
  "facility.open_status",
  "traffic.los",
  "vms.display",
  "camera.image",
  "device.status",
]);

/**
 * Whether a reading is in effect at `now` (epoch milliseconds). A change-only
 * reading is while its `validUntil` lies ahead, however old it is; any other
 * reading while it was observed within `freshMs` and is not past a
 * `validUntil` it states.
 */
export function readingCurrent(reading: LatestReading, now: number, freshMs: number): boolean {
  const until = reading.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);
  if (CHANGE_ONLY_PROPERTIES.has(reading.property)) return Number.isFinite(until) && until > now;
  if (Number.isFinite(until) && until < now) return false;
  return now - observedAt(reading) <= freshMs;
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
 * whole reading goes, even when an allowed contributor agreed with it. The
 * crowd is excluded as a feed is: while `/sources` states no crowd credit,
 * no reading the crowd contributed to is shown.
 */
export function allowedReadings(
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean,
): LatestReading[] {
  return latest.filter((r) => !readingSources(r).some(excluded));
}

/** What a credit reads from the live data sources. */
export interface CreditSources {
  /** A source's link by source id. */
  link(sourceId: string): string | undefined;
  /** The crowd's credit, as `/sources` states it. */
  crowd(): Attribution | undefined;
  /** The notice a source's publisher requires to accompany any display of its data. */
  noticeOf?(sourceId: string): string | undefined;
}

/** One credit per notice the publishers of the kept sources require to accompany their data. */
export function noticeCredits(
  kept: readonly RecordSource[],
  sources: CreditSources,
): Attribution[] {
  return kept.flatMap((source) => {
    const notice = sources.noticeOf?.(source.id);
    return notice ? [{ sourceId: source.id, name: notice }] : [];
  });
}

/** No live data sources: no links and no crowd credit. */
export const NO_SOURCES: CreditSources = {
  link: () => undefined,
  crowd: () => undefined,
};

/** Selected observation credits never borrow a feature's or the current source catalogue's terms. */
export function readingCredits(
  ...readings: readonly (LatestReading | null | undefined)[]
): Attribution[] {
  return snapshotContributors(
    ...readings.map((reading) => {
      const captured = sourcesOf({ provenance: reading?.provenance }).filter(
        (source) => !FUSED.has(source.id),
      );
      return snapshotContributors(
        captured.map((source) => credit(source, NO_SOURCES)),
        upstreamCredits(captured, NO_SOURCES),
      );
    }),
  );
}

/** Captured record/offer suppliers, independent of the current source catalogue. */
export function recordCredits(record: Rec): Attribution[] {
  const native = readCapturedContributors(record.contributors);
  if (native !== undefined) return snapshotContributors(native);
  const captured = sourcesOf(record).map((source) => ({
    ...source,
    id: str(source.attribution.parentSourceId) ?? source.id,
  }));
  return snapshotContributors(
    captured.map((source) => credit(source, NO_SOURCES)),
    upstreamCredits(captured, NO_SOURCES),
    captured.flatMap((source) => {
      const notice = str(source.attribution.notice);
      return notice ? [{ sourceId: source.id, name: notice }] : [];
    }),
  );
}

/** Normalize the model's independently captured terms URL into portable evidence.
 * Matches OpenConditions creditLicensingOf; existing grants/notices stay authoritative.
 */
function capturedCreditLicensing(captured: Rec): Licensing | undefined {
  const licensing = parseLicensing(captured.licensing);
  const url = str(captured.licenseUrl);
  if (
    !url ||
    !isSafeAttributionUrl(url) ||
    licensing?.declarations?.some((d) => d.url === url) ||
    licensing?.bindings.some((b) => b.license.url === url)
  )
    return licensing;
  const declarations = [...(licensing?.declarations ?? [])];
  const license = str(captured.license);
  const matched =
    license === undefined
      ? -1
      : declarations.findIndex((d) => d.text === license && d.url === undefined);
  if (matched >= 0) declarations[matched] = { ...declarations[matched], url };
  else declarations.push({ ...(license ? { text: license } : {}), url });
  return parseLicensing({ ...(licensing ?? { version: 1, bindings: [] }), declarations });
}

/** A source's credit; without a link of its own it takes the source's link from `sources`. */
export function credit(source: RecordSource, sources: CreditSources): Attribution {
  const a = source.attribution;
  const url = str(a.url) ?? sources.link(source.id);
  const licensing = capturedCreditLicensing(a);
  return {
    sourceId: source.id,
    name: str(a.name) ?? str(a.provider) ?? source.id,
    ...(url ? { url } : {}),
    ...(licensing ? { licensing } : {}),
    ...(str(rec(a.publisher).name)
      ? {
          publisher: {
            name: str(rec(a.publisher).name)!,
            ...(str(rec(a.publisher).url) ? { url: str(rec(a.publisher).url) } : {}),
          },
        }
      : {}),
    ...(str(a.provider) ? { attributionText: str(a.provider) } : {}),
  };
}

/**
 * The credits of the upstream publishers the aggregators among the kept
 * sources took the feature from: one per publisher, named "<feed provider> –
 * <publisher>" under the feed it came through, with the licence's own text
 * linked where the publisher states one. A publisher is owed credit whatever
 * its licence, so one without a licence is credited by name.
 */
export function upstreamCredits(
  kept: readonly RecordSource[],
  sources: CreditSources,
): Attribution[] {
  const out: Attribution[] = [];
  for (const source of kept) {
    const feed = credit(source, sources);
    for (const u of source.upstream) {
      const original = rec(u.source);
      const originalId = str(original.sourceId);
      if (originalId) {
        const attribution = rec(original.attribution);
        out.push(
          credit(
            { id: str(attribution.parentSourceId) ?? originalId, attribution, upstream: [] },
            NO_SOURCES,
          ),
        );
        continue;
      }
      const publisher = str(u.publisher);
      if (!publisher) continue;
      const licensing = parseLicensing(u.licensing);
      const name = `${feed.name} – ${publisher}`;
      out.push({
        sourceId: source.id,
        name,
        ...(licensing ? { licensing } : {}),
        publisher: { name: publisher },
        ...(str(u.attribution) ? { attributionText: str(u.attribution) } : {}),
      });
    }
  }
  return snapshotContributors(out);
}

/**
 * The OpenConditions licences a location table is published under that SPDX
 * does not list, as OpenConditions' licence catalogue defines them.
 */
const LOCATION_TABLE_LICENCES: Readonly<Record<string, { name: string; url: string }>> = {
  "LicenseRef-OD-HR": {
    name: "Otvorena dozvola / Open Licence (Croatia)",
    url: "https://data.gov.hr/otvorena-dozvola",
  },
};

/**
 * A location table's licence id as a licence: an SPDX id as itself, a
 * licence OpenConditions defines with that definition, anything else as an
 * unknown licence that keeps the id it was stated with.
 */
function locationTableLicensing(subject: string, id: string): Licensing {
  const spdx = canonicalLicenseExpression(id);
  const custom = LOCATION_TABLE_LICENCES[id];
  const license: LicenseDescriptor = spdx
    ? { kind: "spdx", expression: spdx }
    : custom
      ? { kind: "custom", namespace: "openconditions:licences", id, ...custom }
      : { kind: "unknown", raw: id };
  return {
    version: 1,
    bindings: [{ scope: "data", subject, license }],
    declarations: [{ text: id }],
  };
}

/**
 * The credit of the location table a record was placed with, as
 * `location.locationTable` states it: a TMC location code list, or the
 * administrative boundaries an alert's area was drawn from. It is credited
 * under `sourceId`, the feed whose record the location belongs to, since the
 * table came to OpenMapX inside that feed's records and OpenMapX contacts no
 * one for it. The table's own notice is kept verbatim and the credit links
 * its licence. A table that states no notice is credited by no one.
 */
export function locationTableCredits(record: Rec, sourceId: string | undefined): Attribution[] {
  const table = rec(rec(record.location).locationTable);
  const ref = str(table.ref);
  const version = str(table.version);
  const notice = str(table.attribution);
  if (!sourceId || !ref || !version || !notice) return [];
  const name = `${ref} (${version})`;
  const id = str(table.license);
  const licensing = id ? parseLicensing(locationTableLicensing(name, id)) : undefined;
  const url = licensing ? licensingLinks(licensing)[0]?.url : undefined;
  return [
    {
      sourceId,
      name,
      ...(url ? { url } : {}),
      ...(licensing ? { licensing } : {}),
      attributionText: notice,
    },
  ];
}

export function addressOf(location: Rec): string | undefined {
  const address = rec(location.address);
  const street = [str(address.street), str(address.houseNumber)].filter(Boolean).join(" ");
  const place = [str(address.postalCode), str(address.city)].filter(Boolean).join(" ");
  const line = [street, place].filter(Boolean).join(", ");
  return line.length > 0 ? line : undefined;
}

export function countryOf(location: Rec): string | undefined {
  const country = str(rec(location.address).country) ?? str(rec(location.admin).country);
  return country && /^[a-z]{2}$/i.test(country) ? country.toUpperCase() : undefined;
}

export function pointOf(location: Rec): [number, number] | undefined {
  const geometry = rec(location.geometry);
  const coordinates = geometry.coordinates;
  if (geometry.type !== "Point" || !Array.isArray(coordinates)) return undefined;
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
