import type { EvChargingConnector, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import {
  FI_DIGITRAFFIC_LOCATIONS_URL,
  type FiConnector,
  type FiLocation,
  type FiLocationsFeatureCollection,
  fetchAllFiTariffs,
} from "./fi-digitraffic-client.js";
import { buildFiTariffMapById } from "./fi-digitraffic-tariff.js";
import { createTariffCollector } from "./tariff-collector.js";
import { cleanString, connector } from "./utils.js";

export { FI_DIGITRAFFIC_LOCATIONS_URL };

const SOURCE_URL = "https://www.digitraffic.fi/en/road-traffic/afir/";

function mapConnectorStandard(standard: string | undefined): string {
  switch (standard) {
    case "IEC_62196_T2":
      return "Type 2";
    case "IEC_62196_T2_COMBO":
      return "CCS (Type 2)";
    case "CHADEMO":
      return "CHAdeMO";
    case "DOMESTIC_F":
    case "DOMESTIC_H":
      return "Schuko";
    case "IEC_62196_T1":
      return "Type 1";
    default:
      return "Unknown";
  }
}

function mapCurrentType(powerType: string | undefined): "AC" | "DC" {
  return powerType === "DC" ? "DC" : "AC";
}

function roundKw(watts: number | undefined): number | undefined {
  if (typeof watts !== "number" || !Number.isFinite(watts)) return undefined;
  return Math.round((watts / 1000) * 10) / 10;
}

// Resolves a connector's tariffs via its own `tariffIds[]` (the join is
// connector-level in this feed, not evse-level). Content-deduping — and keeping
// which connectors each tariff was joined to — is the collector's job.
function connectorTariffs(
  conn: FiConnector,
  tariffMap: Map<string, EvChargingTariff[]>,
): EvChargingTariff[] {
  const out: EvChargingTariff[] = [];
  for (const rawId of conn.tariffIds ?? []) {
    const tariffId = cleanString(rawId);
    if (!tariffId) continue;
    out.push(...(tariffMap.get(tariffId) ?? []));
  }
  return out;
}

function mapFeatureToRow(
  feature: FiLocation,
  tariffMap: Map<string, EvChargingTariff[]>,
): PoiRow | null {
  const props = feature.properties;
  const poiId = cleanString(props?.id);
  if (!poiId) return null;

  const coords = feature.geometry?.coordinates;
  const lng = Array.isArray(coords) ? Number(coords[0]) : Number.NaN;
  const lat = Array.isArray(coords) ? Number(coords[1]) : Number.NaN;
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;

  const connectors: EvChargingConnector[] = [];
  const tariffCollector = createTariffCollector();
  for (const evse of props?.evses ?? []) {
    for (const conn of evse.connectors ?? []) {
      const mapped = connector({
        type: mapConnectorStandard(conn.standard),
        powerKw: roundKw(conn.maxElectricPower),
        currentType: mapCurrentType(conn.powerType),
      });
      connectors.push(mapped);
      tariffCollector.add([mapped], connectorTariffs(conn, tariffMap));
    }
  }

  const operatorName = cleanString(props?.operator?.details?.name);

  return {
    poiId,
    lng,
    lat,
    payload: {
      // Coordinates duplicated in payload: the reader hands the mapper only
      // (poiId, payload) — geom is used for the SQL bbox filter, not returned.
      coordinates: [lng, lat] as [number, number],
      name: cleanString(props?.name) ?? "EV Charging Station",
      address: {
        line1: cleanString(props?.address?.street),
        town: cleanString(props?.address?.city),
        postcode: cleanString(props?.address?.postalCode),
        country: "Finland",
      },
      operator: operatorName
        ? { name: operatorName, url: cleanString(props?.operator?.details?.website) }
        : undefined,
      status: "unknown",
      openingHours: props?.openingTimes?.twentyFourSeven ? "24/7" : undefined,
      connectors,
      tariffs: tariffCollector.build(connectors),
      updatedAt: cleanString(props?.modifiedAt),
      sourceUrl: SOURCE_URL,
    },
  };
}

async function* iterate(seed: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  // Tariffs are fetched fresh every run (not seeded — the poi-ingest fetch
  // stage only pre-fetches the locations feed) so the elements/restrictions
  // join stays consistent within one ingest.
  const tariffs = await fetchAllFiTariffs(log);
  if (tariffs.length === 0) {
    log.error(
      "fi-digitraffic-parser: no tariffs fetched this run — stations will have no pricing until next successful fetch",
    );
  }
  const tariffMap = buildFiTariffMapById(tariffs);

  let collection: FiLocationsFeatureCollection;
  try {
    collection = JSON.parse(seed.toString("utf-8")) as FiLocationsFeatureCollection;
  } catch (err) {
    log.error(
      `fi-digitraffic-parser: failed to parse locations GeoJSON (${(err as Error).message})`,
    );
    return;
  }

  // Digitraffic assigns stable per-location ids, but dedupe defensively so a
  // stray collision never aborts the whole Postgres upsert. Keeps the FIRST.
  const seen = new Set<string>();
  for (const feature of collection.features ?? []) {
    const row = mapFeatureToRow(feature, tariffMap);
    if (!row) continue;
    if (seen.has(row.poiId)) {
      log.warn(`fi-digitraffic-parser: dropping duplicate location for poiId ${row.poiId}`);
      continue;
    }
    seen.add(row.poiId);
    yield row;
  }
}

export const parseFiDigitraffic: PoiStaticParseFn = (buffer, { log }) => iterate(buffer, log);
