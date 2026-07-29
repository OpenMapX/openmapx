import type { EvChargingConnector, EvChargingTariff } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { fetchAllLtLocations, fetchAllLtTariffs, type LtLocation } from "./lt-vialietuva-client.js";
import { buildLtTariffMapById } from "./lt-vialietuva-tariff.js";
import { cleanString, connector, idString } from "./utils.js";

const SOURCE_URL = "https://ev.vialietuva.lt/en/data-provision";

function mapConnectorStandard(standard: string | undefined): string {
  switch (standard) {
    case "IEC_62196_T2":
      return "Type 2";
    case "IEC_62196_T2_COMBO":
      return "CCS (Type 2)";
    case "CHADEMO":
      return "CHAdeMO";
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

/**
 * Derives the Via Lietuva station poiId from an OCPI Location's composite
 * identity (`country_code` + `party_id` + `id` — `id` alone is only unique
 * per country_code+party_id per the OCPI spec, same caveat the DOT-NL scout
 * report documents). This mirrors `nlDotnlLocationPoiId` in utils.ts, but that
 * shared helper coerces `id` with `cleanString`, which rejects LT's numeric
 * `id` field (e.g. `440`) outright and would drop every location. `idString`
 * handles both numbers and strings, so the composite key is built locally
 * here instead of reusing the shared helper as-is.
 */
function ltLocationPoiId(location: LtLocation): string | undefined {
  const id = idString(location.id);
  if (!id) return undefined;
  const countryCode = cleanString(location.country_code)?.toUpperCase();
  const partyId = cleanString(location.party_id)?.toUpperCase();
  const prefixParts = [countryCode, partyId].filter((part): part is string => Boolean(part));
  const key = prefixParts.length > 0 ? `${prefixParts.join("*")}*${id}` : id;
  return encodeURIComponent(key);
}

/**
 * Resolves a station's collected connector `tariff_ids` against the tariff-id
 * map, content-deduping so a station whose connectors share the same tariff
 * id (or several connectors resolve to identical tariff content) doesn't
 * carry duplicate entries in its `tariffs` array.
 */
function collectTariffs(
  tariffIds: ReadonlySet<string>,
  tariffMap: Map<string, EvChargingTariff[]>,
): EvChargingTariff[] | undefined {
  const seen = new Set<string>();
  const out: EvChargingTariff[] = [];
  for (const id of tariffIds) {
    for (const tariff of tariffMap.get(id) ?? []) {
      const key = JSON.stringify({
        elements: tariff.elements,
        restrictions: tariff.restrictions,
        source: tariff.source,
      });
      if (!seen.has(key)) {
        seen.add(key);
        out.push(tariff);
      }
    }
  }
  return out.length > 0 ? out : undefined;
}

function mapLocationToRow(
  location: LtLocation,
  tariffMap: Map<string, EvChargingTariff[]>,
): PoiRow | null {
  const poiId = ltLocationPoiId(location);
  if (!poiId) return null;

  const lat = Number.parseFloat(location.coordinates?.latitude ?? "");
  const lng = Number.parseFloat(location.coordinates?.longitude ?? "");
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const tariffIds = new Set<string>();
  const connectors: EvChargingConnector[] = [];
  for (const evse of location.evses ?? []) {
    for (const conn of evse.connectors ?? []) {
      for (const tariffId of conn.tariff_ids ?? []) {
        const cleaned = idString(tariffId ?? undefined);
        if (cleaned) tariffIds.add(cleaned);
      }
      connectors.push(
        connector({
          type: mapConnectorStandard(conn.standard),
          powerKw: roundKw(conn.max_electric_power),
          currentType: mapCurrentType(conn.power_type),
          reference: idString(conn.id),
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
      coordinates: [lng, lat] as [number, number],
      name: cleanString(location.name) ?? "EV Charging Station",
      address: {
        line1: cleanString(location.address),
        town: cleanString(location.city),
        country: "Lithuania",
      },
      operator: operatorName
        ? { name: operatorName, url: cleanString(location.operator?.website) }
        : undefined,
      status: "unknown",
      connectors,
      tariffs: collectTariffs(tariffIds, tariffMap),
      updatedAt: cleanString(location.last_updated),
      sourceUrl: SOURCE_URL,
    },
  };
}

async function* iterate(log: PoiSourceLogger): AsyncIterable<PoiRow> {
  // Locations and tariffs are both fetched internally (with the required
  // User-Agent header) rather than via the seed buffer — see parseLtVialietuva
  // below.
  const [locations, tariffs] = await Promise.all([
    fetchAllLtLocations(log),
    fetchAllLtTariffs(log),
  ]);

  if (locations.length === 0) {
    log.error("lt-vialietuva-parser: no locations fetched this run");
  }
  if (tariffs.length === 0) {
    log.error(
      "lt-vialietuva-parser: no tariffs fetched this run — stations will have no pricing until next successful fetch",
    );
  }
  const tariffMap = buildLtTariffMapById(tariffs);

  // Dedupe by composite poiId. Two sources of duplicates: (1) the fixed-step
  // pagination in the client intentionally overlaps offset windows, so the same
  // location legitimately appears on adjacent pages; (2) a real composite-key
  // collision must never reach the Postgres upsert and abort the batch on a
  // duplicate PK. Keeps the FIRST. The overlap count is expected (hundreds), so
  // log one summary line rather than a warning per dropped row.
  const seen = new Set<string>();
  let dropped = 0;
  for (const location of locations) {
    const row = mapLocationToRow(location, tariffMap);
    if (!row) continue;
    if (seen.has(row.poiId)) {
      dropped += 1;
      continue;
    }
    seen.add(row.poiId);
    yield row;
  }
  if (dropped > 0) {
    log.info(
      `lt-vialietuva-parser: ${seen.size} unique stations; dropped ${dropped} duplicate/overlapping rows (pagination overlap)`,
    );
  }
}

// The seed buffer (page 1 of the locations feed, fetched by the generic
// poi-ingest http fetch stage) is intentionally ignored: fetchAllLtLocations
// pages the whole feed itself, and this way the User-Agent + offset/limit
// pagination logic lives in exactly one place (lt-vialietuva-client.ts)
// instead of being split between the wiring and this parser.
export const parseLtVialietuva: PoiStaticParseFn = (_buffer, { log }) => iterate(log);
