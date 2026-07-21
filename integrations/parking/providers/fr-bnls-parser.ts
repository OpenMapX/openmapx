import { token } from "@openmapx/integration-framework/strings";
import type { BnlsFrRecord, I18nTokenLike } from "@openmapx/mobility-core/parking";
import type { PoiRow } from "@openmapx/poi-source-registry";

/**
 * BNLS France (Opendatasoft mirror) parser.
 *
 * Static-only GeoJSON FeatureCollection. ~826 records covering structured
 * parking facilities across France. `record.id` is the stable per-facility key
 * (pre-migration id was `bnls:${id}`).
 */

interface BnlsGeoJsonResponse {
  type: "FeatureCollection";
  features: Array<{
    type: "Feature";
    geometry: { type: "Point"; coordinates: [number, number] };
    properties: BnlsFrRecord;
  }>;
}

const TYPE_MAP: Record<string, "garage" | "surface"> = {
  ouvrage: "garage",
  enclos_en_surface: "surface",
};

function buildTariffRows(record: BnlsFrRecord): [I18nTokenLike, string][] | undefined {
  const rows: [I18nTokenLike, string][] = [];
  if (record.cost_1h != null) rows.push([token("tariff.dur1h"), `€${record.cost_1h.toFixed(2)}`]);
  if (record.cost_2h != null) rows.push([token("tariff.dur2h"), `€${record.cost_2h.toFixed(2)}`]);
  if (record.cost_3h != null) rows.push([token("tariff.dur3h"), `€${record.cost_3h.toFixed(2)}`]);
  if (record.cost_4h != null) rows.push([token("tariff.dur4h"), `€${record.cost_4h.toFixed(2)}`]);
  if (record.cost_24h != null) {
    rows.push([token("tariff.dur1day"), `€${record.cost_24h.toFixed(2)}`]);
  }
  if (record.resident_sub != null) {
    rows.push([token("tariff.monthlyResident"), `€${record.resident_sub.toFixed(2)}`]);
  }
  if (record.non_resident_sub != null) {
    rows.push([token("tariff.monthly"), `€${record.non_resident_sub.toFixed(2)}`]);
  }
  return rows.length > 0 ? rows : undefined;
}

export function parseFrBnlsStatic(buffer: Buffer): PoiRow[] {
  const text = buffer.toString("utf-8");
  let data: BnlsGeoJsonResponse;
  try {
    data = JSON.parse(text) as BnlsGeoJsonResponse;
  } catch {
    return [];
  }
  if (!Array.isArray(data?.features)) return [];

  const out: PoiRow[] = [];
  for (const feature of data.features) {
    const record = feature.properties;
    if (!record?.id) continue;
    const geomCoords = feature.geometry?.coordinates;
    const lng = geomCoords?.[0] ?? record.xlong ?? record.geo_point_2d?.lon;
    const lat = geomCoords?.[1] ?? record.ylat ?? record.geo_point_2d?.lat;
    if (lat == null || lng == null || Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const isFree = record.is_free === 1;
    const capacity =
      record.space_count != null && record.space_count > 0 ? record.space_count : undefined;

    // Max height < 10 is meters, >= 10 already centimeters.
    let maxHeight: number | undefined;
    if (record.max_height != null && record.max_height > 0) {
      maxHeight =
        record.max_height < 10
          ? Math.round(record.max_height * 100)
          : Math.round(record.max_height);
    }

    const disabledSpaces =
      record.disable_count != null && record.disable_count > 0 ? record.disable_count : undefined;
    const chargingSpaces =
      record.electric_car_count != null && record.electric_car_count > 0
        ? record.electric_car_count
        : undefined;
    const hasPnR = record.park_ride_count != null && record.park_ride_count > 0;

    out.push({
      poiId: record.id,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: record.name || "Parking",
        parkingType: TYPE_MAP[record.facilities_type ?? ""] ?? "unknown",
        capacity,
        disabledSpaces,
        chargingSpaces,
        maxHeight,
        fee: isFree ? "free" : capacity ? "paid" : "unknown",
        feeDescription: record.info ?? undefined,
        tariffRows: isFree ? undefined : buildTariffRows(record),
        access: record.user_type === "abonnes" ? "permit" : "public",
        address: record.address ?? undefined,
        parkAndRide: hasPnR || undefined,
        url: record.url ?? undefined,
      },
    });
  }
  return out;
}
