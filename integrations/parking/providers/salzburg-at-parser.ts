import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadt Salzburg parking WFS bundled parser.
 *
 * GeoJSON FeatureCollection of all city-recognised parking facilities. Some
 * entries carry live availability via Yunex-Traffic; the rest are static
 * directory entries. The live `FREIE_PLAETZE` string is encoded as
 * `"<freeSpaces> (<occupancyPercent>%)"` or `"nicht bekannt"`. `FREIE_PLAETZE_STATUS`
 * is `1` when live, `0` when unknown.
 */

interface SalzburgFeatureProperties {
  ID?: number;
  BEZEICHNUNG?: string;
  ADRESSE?: string | null;
  TYP?: string;
  TARIF?: string | null;
  KAPAZITAET?: number | null;
  OEFFNUNGSZEITEN?: string | null;
  URL?: string | null;
  DATENQUELLE_NAME?: string | null;
  DATENQUELLE_URL?: string | null;
  ANMERKUNGEN?: string | null;
  TELEFON?: string | null;
  FREIE_PLAETZE?: string | null;
  FREIE_PLAETZE_STATUS?: number;
  BELEGUNG_TENDENZ?: string | null;
  BELEGUNG_AKTUALISIERT?: string | null;
}

interface SalzburgFeature {
  type: "Feature";
  id?: string;
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: SalzburgFeatureProperties;
}

interface SalzburgGeoJsonResponse {
  type?: "FeatureCollection";
  features?: SalzburgFeature[];
}

function mapParkingType(typ: string | undefined): "garage" | "surface" {
  if (!typ) return "surface";
  return typ.toLowerCase().includes("garage") || typ.toLowerCase().includes("parkhaus")
    ? "garage"
    : "surface";
}

function mapTrend(
  value: string | null | undefined,
): "increasing" | "decreasing" | "constant" | undefined {
  if (!value) return undefined;
  const v = value.toLowerCase();
  if (v.includes("steig")) return "increasing";
  if (v.includes("fall") || v.includes("sink")) return "decreasing";
  if (v.includes("konstant") || v.includes("gleich")) return "constant";
  return undefined;
}

/**
 * Salzburg encodes the timestamp as `D.M.YYYY HH:MM` in CET/CEST. We normalise
 * to ISO 8601 in the local zone (+01:00 / +02:00 depending on date) so the
 * staleness check in the mapper has a well-formed value to parse. Falls back
 * to `undefined` if the format is unexpected.
 */
function parseGermanTimestamp(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{2})$/);
  if (!match) return undefined;
  const [, dStr, mStr, yStr, hStr, minStr] = match;
  const d = Number(dStr);
  const m = Number(mStr);
  const y = Number(yStr);
  const h = Number(hStr);
  const min = Number(minStr);
  if (!Number.isFinite(d) || !Number.isFinite(m) || !Number.isFinite(y)) return undefined;
  // Treat as UTC for staleness comparison — at worst we're off by 1–2 hours,
  // which is well within the 30-minute staleness window already shifted by
  // the cron cadence. Avoids hard-coding DST rules client-side.
  const date = new Date(Date.UTC(y, m - 1, d, h, min));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function parseFreeSpaces(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const match = raw.match(/^(\d+)/);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : undefined;
}

export const parseSalzburgAtBundled: PoiBundledParseFn = (buffer) => {
  let data: SalzburgGeoJsonResponse;
  try {
    data = JSON.parse(buffer.toString("utf-8")) as SalzburgGeoJsonResponse;
  } catch {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }
  if (!Array.isArray(data?.features)) {
    return { static: [], live: new Map<string, PoiLiveState>() };
  }

  const staticRows: PoiRow[] = [];
  const live = new Map<string, PoiLiveState>();
  const fallbackAsOf = new Date().toISOString();

  for (const feature of data.features) {
    const props = feature.properties ?? {};
    const idValue = props.ID;
    if (typeof idValue !== "number") continue;
    const poiId = String(idValue);
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const capacity =
      typeof props.KAPAZITAET === "number" && props.KAPAZITAET > 0 ? props.KAPAZITAET : undefined;

    const anmerkungen = props.ANMERKUNGEN?.trim();
    const qualityWarnings = anmerkungen ? [anmerkungen] : undefined;

    staticRows.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name: props.BEZEICHNUNG || "Parking",
        parkingType: mapParkingType(props.TYP),
        capacity,
        fee: "paid",
        access: "public",
        address: props.ADRESSE ?? undefined,
        openingHours: props.OEFFNUNGSZEITEN ?? undefined,
        feeDescription: props.TARIF ?? undefined,
        url: props.URL ?? undefined,
        operator: props.DATENQUELLE_NAME ?? undefined,
        // Upstream data-source link — DATENQUELLE_URL points at the
        // originating provider (Yunex Traffic, city department, …).
        sourceUrl: props.DATENQUELLE_URL ?? undefined,
        qualityWarnings,
      },
    });

    if (props.FREIE_PLAETZE_STATUS === 1) {
      const freeSpaces = parseFreeSpaces(props.FREIE_PLAETZE);
      const trend = mapTrend(props.BELEGUNG_TENDENZ);
      // Emit a live entry whenever the upstream flags this facility as live
      // (STATUS=1), even if `FREIE_PLAETZE` is "nicht bekannt" — the trend is
      // still useful on its own ("filling up" vs "emptying") and shouldn't
      // be silently dropped just because the absolute count is missing.
      if (freeSpaces != null || trend != null) {
        live.set(poiId, {
          asOf: parseGermanTimestamp(props.BELEGUNG_AKTUALISIERT) ?? fallbackAsOf,
          freeSpaces,
          trend,
        });
      }
    }
  }

  return { static: staticRows, live };
};
