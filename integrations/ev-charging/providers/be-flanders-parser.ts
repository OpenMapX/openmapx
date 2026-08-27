import { readBoundedBinaryResponse } from "@openmapx/core/server";
import type { EvChargingConnector } from "@openmapx/mobility-core/ev-charging";
import type { PoiRow, PoiSourceLogger, PoiStaticParseFn } from "@openmapx/poi-source-registry";
import { cleanString, connector, splitList, stableHashId } from "./utils.js";

// Flanders "Laadpunten" (public charging points) WFS layer. `srsName=EPSG:4326`
// is required — omitting it returns coordinates in the service's native
// projected CRS (Lambert 72), which would silently place every station in the
// wrong place. Paged with count/startIndex; the layer has ~86,944 rows (one
// per physical connector), so the static feed is fetched in 5,000-row pages.
const WFS_BASE =
  "https://geoserver.gis.cloud.mow.vlaanderen.be/geoserver/beleid/wfs?service=WFS&version=2.0.0&request=GetFeature&typeName=laadpunten_public&outputFormat=application/json&srsName=EPSG:4326";
const PAGE_SIZE = 5000;
const PAGE_TIMEOUT_MS = 60_000;
// ~86,944 rows / 5,000 per page ≈ 18 pages today; cap well above that so a
// misbehaving service (e.g. one that never shrinks below `count`) can't loop
// forever.
const MAX_PAGES = 100;

const PORTAL_URL = "https://www.vlaanderen.be/datavindplaats";

export const BE_FLANDERS_URL = pageUrl(0);

function pageUrl(startIndex: number): string {
  return `${WFS_BASE}&count=${PAGE_SIZE}&startIndex=${startIndex}`;
}

interface BeFlandersProperties {
  uniek_identificatienummer?: string;
  evse?: number;
  uitbater?: string;
  kw?: number;
  stroomtype?: string;
  connector?: string;
  adres?: string;
  postcode?: number | string;
  gemeente?: string;
  provincie?: string;
  latitude?: number;
  longitude?: number;
}

interface BeFlandersFeature {
  type?: string;
  geometry?: { type?: string; coordinates?: unknown };
  properties?: BeFlandersProperties;
}

interface BeFlandersFeatureCollection {
  type?: string;
  features?: BeFlandersFeature[];
}

function parsePage(buffer: Buffer): BeFlandersFeatureCollection {
  const parsed = JSON.parse(buffer.toString("utf-8")) as unknown;
  return parsed && typeof parsed === "object" ? (parsed as BeFlandersFeatureCollection) : {};
}

function featureCoordinates(feature: BeFlandersFeature): [number, number] | null {
  const coords = feature.geometry?.coordinates;
  if (Array.isArray(coords) && coords.length >= 2) {
    const lng = Number(coords[0]);
    const lat = Number(coords[1]);
    if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  }
  // Fall back to the flattened latitude/longitude properties, which are
  // already WGS84 regardless of what the geometry's CRS turns out to be.
  const props = feature.properties;
  const lat = Number(props?.latitude);
  const lng = Number(props?.longitude);
  if (Number.isFinite(lng) && Number.isFinite(lat)) return [lng, lat];
  return null;
}

function connectorTypeLabel(token: string): string {
  switch (token) {
    case "IEC_62196_T2":
      return "Type 2";
    case "IEC_62196_T2_COMBO":
      return "CCS (Type 2)";
    case "IEC_62196_T1":
      return "Type 1";
    case "CHADEMO":
      return "CHAdeMO";
    case "SCHUKO":
      return "Schuko";
    case "TESLA_S":
    case "TESLA":
      return "Tesla";
    default:
      return "Unknown";
  }
}

function currentTypeFromStroomtype(stroomtype: string | undefined): "AC" | "DC" | undefined {
  const cleaned = cleanString(stroomtype)?.toLowerCase();
  if (!cleaned) return undefined;
  if (cleaned.startsWith("ac")) return "AC";
  if (cleaned.startsWith("dc")) return "DC";
  return undefined;
}

function featureConnectors(props: BeFlandersProperties): EvChargingConnector[] {
  const tokens = splitList(props.connector);
  const currentType = currentTypeFromStroomtype(props.stroomtype);
  return tokens.map((token) =>
    connector({
      type: connectorTypeLabel(token),
      powerKw: typeof props.kw === "number" && Number.isFinite(props.kw) ? props.kw : undefined,
      currentType,
      quantity: 1,
    }),
  );
}

interface StationGroup {
  poiId: string;
  lng: number;
  lat: number;
  uitbater?: string;
  adres?: string;
  gemeente?: string;
  postcode?: string;
  provincie?: string;
  connectors: EvChargingConnector[];
}

/**
 * Groups per-connector WFS rows into one row per physical station. The feed's
 * `uniek_identificatienummer` is `<locationId>__<connectorId>` — the segment
 * BEFORE "__" is the physical-station id (verified against the live feed: those
 * prefixes map 1:1 to distinct coordinates — no prefix spans two sites and no
 * site carries two prefixes), so a hub's many connector rows collapse into one
 * station instead of one marker per connector. The whole value is unique per
 * row, so grouping on it (the previous behaviour) produced no merging at all.
 * Falls back to the whole value, then to rounded coordinates (~1m), when the
 * "__" separator is absent (defensive — not observed in practice).
 */
function ingestFeature(feature: BeFlandersFeature, groups: Map<string, StationGroup>): void {
  const props = feature.properties;
  if (!props) return;
  const coordinates = featureCoordinates(feature);
  if (!coordinates) return;
  const [lng, lat] = coordinates;

  const rawUid = cleanString(props.uniek_identificatienummer);
  const stationKey = rawUid ? rawUid.split("__")[0] || rawUid : undefined;
  const groupKey = stationKey ?? `coord:${lat.toFixed(5)}:${lng.toFixed(5)}`;

  const existing = groups.get(groupKey);
  if (existing) {
    existing.connectors.push(...featureConnectors(props));
    return;
  }

  groups.set(groupKey, {
    poiId: stableHashId(groupKey),
    lng,
    lat,
    uitbater: cleanString(props.uitbater),
    adres: cleanString(props.adres),
    gemeente: cleanString(props.gemeente),
    postcode: props.postcode === undefined ? undefined : String(props.postcode),
    provincie: cleanString(props.provincie),
    connectors: featureConnectors(props),
  });
}

function toPoiRow(group: StationGroup): PoiRow {
  const name = [group.uitbater, group.adres].filter(Boolean).join(" – ") || "EV Charging Station";
  return {
    poiId: group.poiId,
    lng: group.lng,
    lat: group.lat,
    payload: {
      coordinates: [group.lng, group.lat] as [number, number],
      name,
      address: {
        line1: group.adres,
        town: group.gemeente,
        postcode: group.postcode,
        state: group.provincie,
        country: "Belgium",
      },
      operator: group.uitbater ? { name: group.uitbater } : undefined,
      status: "unknown",
      connectors: group.connectors,
      sourceUrl: PORTAL_URL,
    },
  };
}

async function fetchNextPage(startIndex: number, log: PoiSourceLogger): Promise<Buffer | null> {
  try {
    const res = await globalThis.fetch(pageUrl(startIndex), {
      signal: AbortSignal.timeout(PAGE_TIMEOUT_MS),
    });
    if (!res.ok) {
      log.error(
        `be-flanders-parser: HTTP ${res.status} at startIndex ${startIndex} — returning partial data`,
      );
      return null;
    }
    return (
      await readBoundedBinaryResponse(res, {
        maxBytes: 32 * 1024 * 1024,
        fallbackContentType: "application/json",
        label: "Flanders charging page",
      })
    ).data;
  } catch (err) {
    log.error(
      `be-flanders-parser: fetch failed at startIndex ${startIndex} (${(err as Error).message}) — returning partial data`,
    );
    return null;
  }
}

async function* iterate(seed: Buffer, log: PoiSourceLogger): AsyncIterable<PoiRow> {
  const groups = new Map<string, StationGroup>();

  let buffer: Buffer | null = seed;
  let startIndex = 0;
  let pages = 0;

  while (buffer) {
    pages += 1;
    const page = parsePage(buffer);
    const features = page.features ?? [];
    for (const feature of features) ingestFeature(feature, groups);

    // The WFS service returns fewer than `count` features on the last page —
    // that's the sole termination signal since `numberMatched`/`totalFeatures`
    // aren't guaranteed to be present on every deployment.
    if (features.length < PAGE_SIZE) break;
    if (pages >= MAX_PAGES) {
      log.warn(`be-flanders-parser: page cap (${MAX_PAGES}) hit — data truncated`);
      break;
    }

    startIndex += PAGE_SIZE;
    buffer = await fetchNextPage(startIndex, log);
  }

  for (const group of groups.values()) yield toPoiRow(group);
}

export const parseBeFlanders: PoiStaticParseFn = (buffer, { log }) => iterate(buffer, log);
