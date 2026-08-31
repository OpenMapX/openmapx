import { clusterSpatialItems, type DataSourceResult } from "@openmapx/core";
import type {
  EvChargingConnector,
  EvChargingStation,
  EvChargingStatus,
} from "@openmapx/mobility-core/ev-charging";
import { getEvChargingSourcePrefix, getEvChargingSourcePriority } from "./source-priority.js";
import { haversineMeters, newestIsoString, uniqueAttributions, uniqueStrings } from "./utils.js";

function stationPriority(station: EvChargingStation): number {
  return getEvChargingSourcePriority(station.sources[0]);
}

// EV clustering deliberately widens past `DEDUP.EV_RADIUS_M` (50 m) into a
// three-tier window — 20 m always, 20-90 m soft with names, 90-150 m strict
// with names + operator + address — because physical charging sites span
// multiple bays and shared infrastructure across operators.
const ALWAYS_MERGE_M = 20;
const SOFT_MERGE_M = 90;
const NEVER_MERGE_M = 150;

const NAME_STOPWORDS = new Set([
  "ev",
  "electric",
  "vehicle",
  "charger",
  "chargers",
  "charging",
  "station",
  "stations",
  "ladepunkt",
  "ladepunkte",
  "ladesaeule",
  "ladesäule",
  "ladesäulen",
  "ladestation",
  "ladestationen",
  "borne",
  "recharge",
  "irve",
  "fast",
  "rapid",
  "dc",
  "ac",
  "parking",
  "parkplatz",
  "parkhaus",
  "operator",
  "operators",
  "strasse",
  "straße",
  "str",
  "road",
  "street",
  "the",
  "de",
  "der",
  "die",
  "das",
  "am",
  "an",
  "im",
  "in",
]);

function tokenize(value: string | undefined): string[] {
  if (!value) return [];
  return (value.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(
    (token) => token.length >= 2 && !NAME_STOPWORDS.has(token),
  );
}

function tokenSimilarity(a: string | undefined, b: string | undefined): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.length === 0 || tb.length === 0) return 0;
  const setA = new Set(ta);
  const setB = new Set(tb);
  let intersect = 0;
  for (const token of setA) if (setB.has(token)) intersect++;
  return intersect / Math.min(setA.size, setB.size);
}

function addressText(station: EvChargingStation): string | undefined {
  const address = station.address;
  if (!address) return undefined;
  return [address.line1, address.postcode, address.town, address.state, address.country]
    .filter(Boolean)
    .join(" ");
}

function sourceIds(station: EvChargingStation): Set<string> {
  return new Set([station.id, ...(station.sourceItemIds ?? [])]);
}

function sourceIdsOverlap(a: EvChargingStation, b: EvChargingStation): boolean {
  const ids = sourceIds(a);
  for (const id of sourceIds(b)) if (ids.has(id)) return true;
  return false;
}

function shouldCluster(a: EvChargingStation, b: EvChargingStation): boolean {
  if (sourceIdsOverlap(a, b)) return true;
  const d = haversineMeters(a.coordinates, b.coordinates);
  if (d >= NEVER_MERGE_M) return false;
  if (d <= ALWAYS_MERGE_M) return true;

  const nameScore = tokenSimilarity(a.name, b.name);
  const operatorScore = tokenSimilarity(a.operator?.name, b.operator?.name);
  const addressScore = tokenSimilarity(addressText(a), addressText(b));

  if (d <= SOFT_MERGE_M) {
    return nameScore >= 0.45 || operatorScore >= 0.75 || addressScore >= 0.6;
  }
  return nameScore >= 0.65 && (operatorScore >= 0.5 || addressScore >= 0.5);
}

function pickByPriority<T>(
  members: EvChargingStation[],
  pick: (station: EvChargingStation) => T | undefined | null,
): T | undefined {
  for (const station of members) {
    const value = pick(station);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickRichestString(values: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const value of values) {
    if (!value) continue;
    if (best === undefined || value.length > best.length) best = value;
  }
  return best;
}

function dedupeSources(primary: string, all: string[]): string[] {
  const seen = new Map<string, string>();
  seen.set(getEvChargingSourcePrefix(primary), primary);
  for (const source of all) {
    const prefix = getEvChargingSourcePrefix(source);
    if (!seen.has(prefix)) seen.set(prefix, source);
  }
  return Array.from(seen.values());
}

function statusRank(status: EvChargingStatus | undefined): number {
  if (status === "operational") return 0;
  if (status === "planned") return 1;
  if (status === "not-operational") return 2;
  return 3;
}

function pickStatus(members: EvChargingStation[]): EvChargingStatus | undefined {
  const byPriority =
    pickByPriority(members, (station) =>
      station.status && station.status !== "unknown" ? station.status : undefined,
    ) ?? members[0]?.status;
  if (byPriority && byPriority !== "unknown") return byPriority;

  return [...members]
    .map((station) => station.status)
    .filter((status): status is EvChargingStatus => Boolean(status))
    .sort((a, b) => statusRank(a) - statusRank(b))[0];
}

function connectorKey(connector: EvChargingConnector): string {
  const type = (connector.type ?? "unknown").toLowerCase();
  const current = (connector.currentType ?? "").toLowerCase();
  const power = connector.powerKw ? Math.round(connector.powerKw * 10) / 10 : "";
  return `${type}|${current}|${power}`;
}

interface ConnectorAccumulator {
  connector: EvChargingConnector;
  quantitiesBySource: Map<string, number>;
  references: Set<string>;
}

function mergeConnectors(members: EvChargingStation[]): EvChargingConnector[] {
  const acc = new Map<string, ConnectorAccumulator>();

  for (const member of members) {
    const source = getEvChargingSourcePrefix(member.sources[0]);
    for (const connector of member.connectors) {
      const key = connectorKey(connector);
      let entry = acc.get(key);
      if (!entry) {
        entry = {
          connector: { ...connector },
          quantitiesBySource: new Map(),
          references: new Set(),
        };
        acc.set(key, entry);
      } else {
        entry.connector = {
          ...entry.connector,
          type: entry.connector.type ?? connector.type,
          currentType: entry.connector.currentType ?? connector.currentType,
          powerKw: entry.connector.powerKw ?? connector.powerKw,
          status: entry.connector.status ?? connector.status,
        };
      }

      const qty = connector.quantity && connector.quantity > 0 ? connector.quantity : 1;
      entry.quantitiesBySource.set(source, (entry.quantitiesBySource.get(source) ?? 0) + qty);
      if (connector.reference) entry.references.add(connector.reference);
    }
  }

  return Array.from(acc.values())
    .map((entry) => {
      const quantity = Math.max(...entry.quantitiesBySource.values());
      const references = Array.from(entry.references);
      return {
        ...entry.connector,
        quantity: quantity > 0 ? quantity : undefined,
        reference: references.length === 1 ? references[0] : undefined,
      };
    })
    .sort((a, b) => (b.powerKw ?? 0) - (a.powerKw ?? 0));
}

function mergeAddress(members: EvChargingStation[]): EvChargingStation["address"] {
  const fields = {
    line1:
      pickByPriority(members, (station) => station.address?.line1) ??
      pickRichestString(members.map((station) => station.address?.line1)),
    town:
      pickByPriority(members, (station) => station.address?.town) ??
      pickRichestString(members.map((station) => station.address?.town)),
    state:
      pickByPriority(members, (station) => station.address?.state) ??
      pickRichestString(members.map((station) => station.address?.state)),
    postcode:
      pickByPriority(members, (station) => station.address?.postcode) ??
      pickRichestString(members.map((station) => station.address?.postcode)),
    country:
      pickByPriority(members, (station) => station.address?.country) ??
      pickRichestString(members.map((station) => station.address?.country)),
  };
  return Object.values(fields).some(Boolean) ? fields : undefined;
}

function mergeCluster(cluster: EvChargingStation[]): EvChargingStation {
  const members = [...cluster].sort((a, b) => stationPriority(a) - stationPriority(b));
  const primary = members[0];
  const allSources = members.flatMap((station) => station.sources);
  const sourceItemIds = uniqueStrings(
    members.map((station) => station.sourceItemIds ?? [station.id]),
  );

  return {
    id: primary.id,
    name:
      pickByPriority(members, (station) =>
        station.name.toLowerCase().includes("charging station") ? undefined : station.name,
      ) ?? primary.name,
    coordinates: primary.coordinates,
    sources: dedupeSources(primary.sources[0], allSources),
    sourceItemIds,
    attributions: uniqueAttributions(members.map((station) => station.attributions)),
    address: mergeAddress(members),
    operator: pickByPriority(members, (station) => station.operator),
    status: pickStatus(members),
    availability: pickByPriority(members, (station) => station.availability),
    isLive: members.some((station) => station.isLive) || undefined,
    usageType:
      pickByPriority(members, (station) => station.usageType) ??
      pickRichestString(members.map((station) => station.usageType)),
    usageCost:
      pickByPriority(members, (station) => station.usageCost) ??
      pickRichestString(members.map((station) => station.usageCost)),
    tariffs: (() => {
      const all = members.flatMap((station) => station.tariffs ?? []);
      return all.length > 0 ? all : undefined;
    })(),
    membershipRequired: pickByPriority(members, (station) => station.membershipRequired),
    openingHours:
      pickByPriority(members, (station) => station.openingHours) ??
      pickRichestString(members.map((station) => station.openingHours)),
    access:
      pickByPriority(members, (station) => station.access) ??
      pickRichestString(members.map((station) => station.access)),
    paymentMethods: uniqueStrings(members.map((station) => station.paymentMethods)),
    connectors: mergeConnectors(members),
    updatedAt: newestIsoString(members.map((station) => station.updatedAt)),
    sourceUrl: pickByPriority(members, (station) => station.sourceUrl),
    notes: uniqueStrings(members.map((station) => station.notes)),
    osmTags: pickByPriority(members, (station) => station.osmTags),
  };
}

export function deduplicateChargingStations(stations: EvChargingStation[]): EvChargingStation[] {
  return clusterSpatialItems(stations, {
    coordinates: (station) => station.coordinates,
    searchRadiusMeters: NEVER_MERGE_M,
    shouldJoin: shouldCluster,
  }).map((cluster) => (cluster.length === 1 ? cluster[0] : mergeCluster(cluster)));
}

/**
 * Compatibility helper retained for older tests/callers. New EV sources use
 * `deduplicateChargingStations` so duplicates are merged instead of dropped.
 */
export function deduplicateByCoordinates(results: DataSourceResult[]): DataSourceResult[] {
  const seen = new Set<string>();
  const deduped: DataSourceResult[] = [];
  for (const result of results) {
    const [lng, lat] = result.coordinates;
    const key = `${Math.round(lat * 10000)},${Math.round(lng * 10000)}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(result);
    }
  }
  return deduped;
}

export { haversineMeters };
