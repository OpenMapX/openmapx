import type { EvChargingConnector, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import {
  DE_OCPDB_ASSOCIATIONS_URL,
  DE_OCPDB_LOCATIONS_URL,
  DE_OCPDB_TARIFFS_URL,
  fetchAllOcpdbItems,
} from "./de-ocpdb-client.js";
import { buildEvseUidToTariffIds, buildTariffMapById } from "./de-ocpdb-tariff.js";
import { cleanString, connector, deOcpdbLocationPoiId, idString } from "./utils.js";

interface OcpdbConnector {
  id?: string;
  standard?: string;
  power_type?: string;
  max_electric_power?: number;
}

interface OcpdbEvse {
  uid?: string | number;
  evse_id?: string;
  status?: string;
  connectors?: OcpdbConnector[];
}

interface OcpdbLocation {
  id?: string;
  name?: string;
  address?: string;
  city?: string;
  postal_code?: string;
  country?: string;
  operator?: { name?: string } | null;
  coordinates?: { latitude?: number | string; longitude?: number | string };
  evses?: OcpdbEvse[];
  last_updated?: string;
}

function mapConnectorStandard(standard: string | undefined): string {
  switch (standard) {
    case "IEC_62196_T2":
      return "Type 2";
    case "IEC_62196_T2_COMBO":
      return "CCS (Type 2)";
    case "CHADEMO":
      return "CHAdeMO";
    case "DOMESTIC_F":
      // German Schuko household socket — common on the BNetzA rows OCPDB
      // re-serves. Normalizes to the same "Schuko" as de-bnetza so a merged
      // duplicate doesn't list the socket twice.
      return "Schuko";
    case "DOMESTIC_E":
      return "Type E (domestic)";
    default:
      return standard ?? "Unknown";
  }
}

function mapCurrentType(powerType: string | undefined): "AC" | "DC" | undefined {
  if (!powerType) return undefined;
  if (powerType.startsWith("AC")) return "AC";
  if (powerType === "DC") return "DC";
  return undefined;
}

function roundKw(watts: number | undefined): number | undefined {
  if (typeof watts !== "number" || !Number.isFinite(watts)) return undefined;
  return Math.round((watts / 1000) * 10) / 10;
}

// Resolves an EVSE's tariffs via the association map (evse.uid → tariff_ids)
// then the by-id tariff map, appending content-deduped tariffs to `out`. OCPDB
// emits one association per EVSE, so a multi-EVSE station collects
// content-identical tariffs — dedupe by content, not object identity, so the
// payload carries one copy per distinct tariff.
function collectTariffs(
  evse: OcpdbEvse,
  evseUidToTariffIds: Map<string, Set<string>>,
  tariffMap: Map<string, EvChargingTariff[]>,
  out: EvChargingTariff[],
  seen: Set<string>,
): void {
  const uid = idString(evse.uid);
  if (!uid) return;
  const tariffIds = evseUidToTariffIds.get(uid);
  if (!tariffIds) return;
  for (const tariffId of tariffIds) {
    for (const tariff of tariffMap.get(tariffId) ?? []) {
      const key = JSON.stringify({
        elements: tariff.elements,
        restrictions: tariff.restrictions,
        isDirectPayment: tariff.isDirectPayment,
        source: tariff.source,
      });
      if (!seen.has(key)) {
        seen.add(key);
        out.push(tariff);
      }
    }
  }
}

function mapLocationToRow(
  raw: unknown,
  tariffMap: Map<string, EvChargingTariff[]>,
  evseUidToTariffIds: Map<string, Set<string>>,
): PoiRow | null {
  if (!raw || typeof raw !== "object") return null;
  const location = raw as OcpdbLocation;

  const poiId = deOcpdbLocationPoiId(location);
  if (!poiId) return null;

  const lat = Number(location.coordinates?.latitude);
  const lng = Number(location.coordinates?.longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const connectors: EvChargingConnector[] = [];
  const tariffs: EvChargingTariff[] = [];
  const seenTariff = new Set<string>();
  for (const evse of location.evses ?? []) {
    collectTariffs(evse, evseUidToTariffIds, tariffMap, tariffs, seenTariff);
    for (const conn of evse.connectors ?? []) {
      connectors.push(
        connector({
          type: mapConnectorStandard(conn.standard),
          powerKw: roundKw(conn.max_electric_power),
          currentType: mapCurrentType(conn.power_type),
          reference: cleanString(conn.id),
        }),
      );
    }
  }

  const operatorName = cleanString(location.operator?.name);

  return {
    poiId,
    lng,
    lat,
    payload: {
      // Coordinates duplicated in payload: the reader hands the mapper only
      // (poiId, payload) — geom is used for the SQL bbox filter, not returned.
      coordinates: [lng, lat] as [number, number],
      name: cleanString(location.name) ?? "EV Charging Station",
      address: {
        line1: cleanString(location.address),
        town: cleanString(location.city),
        postcode: cleanString(location.postal_code),
        country: cleanString(location.country),
      },
      operator: operatorName ? { name: operatorName } : undefined,
      connectors,
      tariffs: tariffs.length > 0 ? tariffs : undefined,
      updatedAt: cleanString(location.last_updated),
    },
  };
}

async function* iterate(seed: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  // Three feeds fetched in one run so the internal evse_uid ↔ tariff_id ids are
  // mutually consistent; we persist only resolved tariffs under the stable
  // poiId, so uid churn between daily runs is harmless.
  const [locations, tariffMap, evseUidToTariffIds] = await Promise.all([
    fetchAllOcpdbItems(DE_OCPDB_LOCATIONS_URL, log, seed),
    fetchAllOcpdbItems(DE_OCPDB_TARIFFS_URL, log).then((t) => {
      if (t.length === 0)
        log.error(
          "de-ocpdb-parser: no tariffs fetched this run — stations will have no pricing until next successful fetch",
        );
      return buildTariffMapById(t);
    }),
    fetchAllOcpdbItems(DE_OCPDB_ASSOCIATIONS_URL, log).then((a) => {
      if (a.length === 0)
        log.error(
          "de-ocpdb-parser: no tariff-associations fetched this run — stations will have no pricing until next successful fetch",
        );
      return buildEvseUidToTariffIds(a);
    }),
  ]);

  // OCPDB assigns globally-unique location ids, but dedupe defensively so a
  // stray collision never aborts the whole Postgres upsert. Keeps the FIRST.
  const seen = new Set<string>();
  for (const raw of locations) {
    const row = mapLocationToRow(raw, tariffMap, evseUidToTariffIds);
    if (!row) continue;
    if (seen.has(row.poiId)) {
      log.warn(`de-ocpdb-parser: dropping duplicate location for poiId ${row.poiId}`);
      continue;
    }
    seen.add(row.poiId);
    yield row;
  }
}

export const parseDeOcpdb: PoiStaticParseFn = (buffer, { log }) => iterate(buffer, log);
