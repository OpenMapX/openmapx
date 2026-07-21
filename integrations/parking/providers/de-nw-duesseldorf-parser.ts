import type { PoiBundledParseFn, PoiLiveState, PoiRow } from "@openmapx/poi-source-registry";

/**
 * Stadt Düsseldorf VT-Manager WFS bundled parser.
 *
 * Single GeoJSON FeatureCollection from the Geoserver — point geometry per
 * Parkhaus + realtime occupancy fields (`kurzparkermax`, `kurzparkerbelegt`,
 * `daysecto_belegung`, `status`). `pid` is the stable per-facility integer
 * key; `vti_url` is the operator's deep link when present.
 *
 * The upstream rejects unset/empty User-Agent with 403, so the source spec
 * sends `User-Agent: Mozilla/5.0` to mirror the city's own client.
 */

interface DuesseldorfFeatureProperties {
  pid?: number;
  name?: string;
  bezeichnung?: string;
  kurzbezeichnung?: string | null;
  parkingareaname?: string | null;
  vti_anschrift?: string | null;
  oeffnungszeiten_statisch?: string | null;
  vti_oeffnungszeiten?: string | null;
  vti_gebuehren?: string | null;
  durchfahrtshoehe?: number | null;
  vti_url?: string | null;
  kurzparkermax?: number | null;
  kurzparkerbelegt?: number | null;
  hatbehindertenstellplaetze?: boolean | null;
  behindertenstellplaetze?: number | null;
  hatfrauenparkplaetze?: boolean | null;
  frauenparkplaetze?: number | null;
  status?: number | null;
  daysecto_belegung?: string | null;
  /** Trend code: 0 = constant, 1 = increasing, 2 = decreasing. */
  tendenz?: number | null;
  tendenzkurzparker?: number | null;
  tendenzdauerparker?: number | null;
}

interface DuesseldorfFeature {
  type: "Feature";
  id?: string;
  geometry?: { type: "Point"; coordinates: [number, number] };
  properties?: DuesseldorfFeatureProperties;
}

interface DuesseldorfGeoJsonResponse {
  type?: "FeatureCollection";
  features?: DuesseldorfFeature[];
}

function mapStatus(status: number | null | undefined): "open" | "closed" | "unknown" {
  // Per the public viewer: 1 = open/operational, anything else (0/2/...) = closed/out-of-service.
  if (status === 1) return "open";
  if (status === 0 || status === 2) return "closed";
  return "unknown";
}

/**
 * Düsseldorf publishes three trend fields (overall + short-term + long-term).
 * `tendenzkurzparker` reflects short-term/visitor occupancy which is the
 * useful signal for someone deciding whether to head to this garage. Falls
 * back to `tendenz` when the short-term variant is unset.
 *
 * Coding (observed): 0 = constant, 1 = increasing, 2 = decreasing.
 */
function mapTrend(
  short: number | null | undefined,
  overall: number | null | undefined,
): "increasing" | "decreasing" | "constant" | undefined {
  const value = typeof short === "number" ? short : typeof overall === "number" ? overall : null;
  if (value === 0) return "constant";
  if (value === 1) return "increasing";
  if (value === 2) return "decreasing";
  return undefined;
}

/**
 * VT-Manager publishes `daysecto_belegung` as ISO 8601 UTC (verified live:
 * `"2026-05-27T17:10:00Z"`). Validate before passing through so a future
 * upstream format change degrades to `fallbackAsOf` rather than producing
 * `NaN` in the mapper's staleness check (which would silently keep stale
 * data labeled as live forever).
 */
function pickAsOf(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const ts = Date.parse(raw);
  return Number.isFinite(ts) ? raw : undefined;
}

function pickAddress(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  // Several entries embed `<br>` between street and ZIP+city. Collapse to a
  // human-readable single line and trim any leading newline.
  return (
    raw
      .replace(/<br\s*\/?>(\s*)/gi, ", ")
      .replace(/\s+/g, " ")
      .trim() || undefined
  );
}

export const parseDeNwDuesseldorfBundled: PoiBundledParseFn = (buffer) => {
  let data: DuesseldorfGeoJsonResponse;
  try {
    data = JSON.parse(buffer.toString("utf-8")) as DuesseldorfGeoJsonResponse;
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
    if (typeof props.pid !== "number") continue;
    const poiId = String(props.pid);
    const coords = feature.geometry?.coordinates;
    if (!coords) continue;
    const [lng, lat] = coords;
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;

    const name = props.name || props.bezeichnung || `Parkhaus ${poiId}`;
    const capacity =
      typeof props.kurzparkermax === "number" && props.kurzparkermax > 0
        ? props.kurzparkermax
        : undefined;
    const maxHeightCm =
      typeof props.durchfahrtshoehe === "number" && props.durchfahrtshoehe > 0
        ? Math.round(props.durchfahrtshoehe * 100)
        : undefined;
    const disabledSpaces =
      typeof props.behindertenstellplaetze === "number" && props.behindertenstellplaetze > 0
        ? props.behindertenstellplaetze
        : props.hatbehindertenstellplaetze === true
          ? 1
          : undefined;
    const womenSpaces =
      typeof props.frauenparkplaetze === "number" && props.frauenparkplaetze > 0
        ? props.frauenparkplaetze
        : props.hatfrauenparkplaetze === true
          ? 1
          : undefined;

    staticRows.push({
      poiId,
      lng,
      lat,
      payload: {
        coordinates: [lng, lat] as [number, number],
        name,
        parkingType: "garage",
        capacity,
        fee: "paid",
        access: "public",
        address: pickAddress(props.vti_anschrift),
        openingHours: props.oeffnungszeiten_statisch ?? props.vti_oeffnungszeiten ?? undefined,
        maxHeight: maxHeightCm,
        disabledSpaces,
        womenSpaces,
        feeDescription: props.vti_gebuehren ?? undefined,
        url: props.vti_url ?? undefined,
      },
    });

    const occupied = typeof props.kurzparkerbelegt === "number" ? props.kurzparkerbelegt : null;
    const freeSpaces =
      capacity != null && occupied != null ? Math.max(0, capacity - occupied) : undefined;
    const state = mapStatus(props.status ?? null);
    const trend = mapTrend(props.tendenzkurzparker, props.tendenz);
    const hasLive = freeSpaces != null || state !== "unknown" || trend != null;
    if (hasLive) {
      live.set(poiId, {
        asOf: pickAsOf(props.daysecto_belegung) ?? fallbackAsOf,
        freeSpaces,
        state,
        trend,
      });
    }
  }

  return { static: staticRows, live };
};
