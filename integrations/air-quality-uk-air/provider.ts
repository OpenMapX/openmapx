import type { AirQualitySourceRef, ProviderEvidence } from "@openmapx/air-quality";
import { indexId, observationId } from "@openmapx/air-quality/ids";
import type {
  AirQualityProvider,
  IntegrationContext,
  PointAirQualityQuery,
  ProviderCallContext,
} from "@openmapx/integration-framework";
import { getXmlChild, getXmlChildren, parseXmlDocument, xmlText } from "@openmapx/mobility-formats";

const ENDPOINT = "https://uk-air.defra.gov.uk/assets/rss/current_site_levels.xml";
const SOURCE_ID = "uk-air-current-site-levels";
const METHOD_REVISION = "uk-air-rss-current-site-levels-v1";
const MAX_RESPONSE_BYTES = 256 * 1_024;
const MAX_XML_DEPTH = 16;
const MAX_XML_ELEMENTS = 4_096;
const MAX_DISTANCE_METERS = 25_000;
const VALIDITY_MS = 2 * 60 * 60_000;

const source: AirQualitySourceRef = {
  sourceId: SOURCE_ID,
  name: "UK-AIR current site pollution levels",
  url: ENDPOINT,
  owner: "UK Department for Environment, Food & Rural Affairs",
  license: {
    name: "Open Government Licence v3.0",
    url: "https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/",
  },
  methodologyUrl: "https://uk-air.defra.gov.uk/air-pollution/daqi",
  attribution: "Department for Environment, Food & Rural Affairs (Defra), UK-AIR",
};

export interface UkAirSiteLevel {
  id: string;
  name: string;
  coordinates: [number, number];
  observedAt: string;
  value: number;
  categoryId: string;
  sourceUrl: string;
}

export interface UkAirFeed {
  publishedAt: string;
  sites: UkAirSiteLevel[];
}

export class UkAirProviderError extends Error {
  constructor(
    message: string,
    readonly code: "invalid_response" | "upstream_failure" = "invalid_response",
  ) {
    super(message);
    this.name = "UkAirProviderError";
  }
}

function instant(value: string | undefined, field: string): string {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) throw new UkAirProviderError(`Invalid UK-AIR ${field}`);
  return new Date(parsed).toISOString();
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function dms(degrees: string, minutes: string, seconds: string, hemisphere: string): number {
  const numericDegrees = Number(degrees);
  const numericMinutes = Number(minutes);
  const numericSeconds = Number(seconds);
  if (
    !Number.isFinite(numericDegrees) ||
    !Number.isFinite(numericMinutes) ||
    numericMinutes < 0 ||
    numericMinutes >= 60 ||
    !Number.isFinite(numericSeconds) ||
    numericSeconds < 0 ||
    numericSeconds >= 60
  )
    return Number.NaN;
  const absolute = numericDegrees + numericMinutes / 60 + numericSeconds / 3_600;
  return round6(/[SW]/.test(hemisphere) ? -absolute : absolute);
}

function expectedBand(value: number): string {
  if (value <= 3) return "Low";
  if (value <= 6) return "Moderate";
  if (value <= 9) return "High";
  return "Very High";
}

function parseSite(value: unknown): UkAirSiteLevel | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const item = value as Record<string, unknown>;
  const name = xmlText(item.title)?.trim();
  const rawUrl = xmlText(item.link)?.trim();
  const description = xmlText(item.description);
  const rawObservedAt = xmlText(item.pubDate);
  if (!name || name.length > 256 || !rawUrl || !description || !rawObservedAt) return null;
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.hostname !== "uk-air.defra.gov.uk" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/data/site-data" ||
    url.hash !== ""
  )
    return null;
  url.protocol = "https:";
  const id = url.searchParams.get("f_site_id");
  if (!id || !/^[A-Z0-9]{1,16}$/.test(id)) return null;
  const coordinate =
    /Location:\s*(\d{1,2})&deg;(\d{1,2})&acute;([\d.]+)&quot;([NS])\s+(\d{1,3})&deg;(\d{1,2})&acute;([\d.]+)&quot;([EW])/i.exec(
      description,
    );
  const pollution =
    /Current Pollution level is\s+(Low|Moderate|High|Very High)\s+at index\s+(10|[1-9])\b/i.exec(
      description,
    );
  if (!coordinate || !pollution) return null;
  const [, latitudeDegrees = "", latitudeMinutes = "", latitudeSeconds = "", northSouth = ""] =
    coordinate;
  const [
    ,
    ,
    ,
    ,
    ,
    longitudeDegrees = "",
    longitudeMinutes = "",
    longitudeSeconds = "",
    eastWest = "",
  ] = coordinate;
  const latitude = dms(latitudeDegrees, latitudeMinutes, latitudeSeconds, northSouth);
  const longitude = dms(longitudeDegrees, longitudeMinutes, longitudeSeconds, eastWest);
  const indexValue = Number(pollution[2]);
  const band = (pollution[1] ?? "").replace(/\s+/g, " ");
  if (
    !Number.isFinite(latitude) ||
    latitude < -90 ||
    latitude > 90 ||
    !Number.isFinite(longitude) ||
    longitude < -180 ||
    longitude > 180 ||
    expectedBand(indexValue).toLowerCase() !== band.toLowerCase()
  )
    return null;
  return {
    id,
    name,
    coordinates: [longitude, latitude],
    observedAt: instant(rawObservedAt, "site publication date"),
    value: indexValue,
    categoryId:
      indexValue <= 3
        ? `low-${indexValue}`
        : indexValue <= 6
          ? `moderate-${indexValue}`
          : indexValue <= 9
            ? `high-${indexValue}`
            : "very-high-10",
    sourceUrl: url.toString(),
  };
}

function assertXmlShapeBounds(xml: string): void {
  if (/<!DOCTYPE/i.test(xml))
    throw new UkAirProviderError("UK-AIR RSS document types are not allowed");
  let depth = 0;
  let elements = 0;
  for (let cursor = 0; cursor < xml.length; cursor += 1) {
    if (xml[cursor] !== "<") continue;
    if (xml.startsWith("<!--", cursor)) {
      const end = xml.indexOf("-->", cursor + 4);
      if (end < 0) return;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<![CDATA[", cursor)) {
      const end = xml.indexOf("]]>", cursor + 9);
      if (end < 0) return;
      cursor = end + 2;
      continue;
    }
    if (xml.startsWith("<?", cursor)) {
      const end = xml.indexOf("?>", cursor + 2);
      if (end < 0) return;
      cursor = end + 1;
      continue;
    }
    if (xml.startsWith("<!", cursor))
      throw new UkAirProviderError("UK-AIR RSS markup declarations are not allowed");

    let position = cursor + 1;
    while (/\s/.test(xml[position] ?? "")) position += 1;
    const closing = xml[position] === "/";
    if (closing) position += 1;
    while (/\s/.test(xml[position] ?? "")) position += 1;
    if (!/[A-Za-z_]/.test(xml[position] ?? ""))
      throw new UkAirProviderError("UK-AIR RSS contains an unsupported XML tag name");

    let quote: '"' | "'" | null = null;
    let end = -1;
    for (let scan = position + 1; scan < xml.length; scan += 1) {
      const character = xml[scan];
      if (quote !== null) {
        if (character === quote) quote = null;
      } else if (character === '"' || character === "'") quote = character;
      else if (character === ">") {
        end = scan;
        break;
      }
    }
    if (end < 0) return;
    let beforeEnd = end - 1;
    while (/\s/.test(xml[beforeEnd] ?? "")) beforeEnd -= 1;
    const selfClosing = xml[beforeEnd] === "/";
    if (closing) {
      depth = Math.max(0, depth - 1);
      cursor = end;
      continue;
    }
    elements += 1;
    if (elements > MAX_XML_ELEMENTS)
      throw new UkAirProviderError("UK-AIR RSS exceeds the XML element limit");
    if (!selfClosing) {
      depth += 1;
      if (depth > MAX_XML_DEPTH)
        throw new UkAirProviderError("UK-AIR RSS exceeds the XML depth limit");
    }
    cursor = end;
  }
}

export function parseUkAirRss(xml: string): UkAirFeed {
  if (Buffer.byteLength(xml) > MAX_RESPONSE_BYTES)
    throw new UkAirProviderError("UK-AIR RSS exceeds the parser byte limit");
  assertXmlShapeBounds(xml);
  let document: ReturnType<typeof parseXmlDocument>;
  try {
    document = parseXmlDocument(xml);
  } catch (error) {
    throw new UkAirProviderError(
      `UK-AIR RSS XML is invalid: ${error instanceof Error ? error.message : "unknown XML error"}`,
    );
  }
  const channel = getXmlChild(getXmlChild(document, "rss"), "channel");
  if (!channel) throw new UkAirProviderError("UK-AIR RSS channel is missing");
  const publishedAt = instant(xmlText(channel.lastBuildDate), "last build date");
  const items = getXmlChildren(channel, "item");
  if (items.length > 500) throw new UkAirProviderError("UK-AIR RSS contains too many sites");
  const sites = items.flatMap((item) => {
    const parsed = parseSite(item);
    return parsed ? [parsed] : [];
  });
  if (sites.length === 0) throw new UkAirProviderError("UK-AIR RSS has no conforming site levels");
  return { publishedAt, sites };
}

function distanceMeters(query: PointAirQualityQuery, site: UkAirSiteLevel): number {
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const dLat = radians(site.coordinates[1] - query.latitude);
  const dLng = radians(site.coordinates[0] - query.longitude);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(radians(query.latitude)) *
      Math.cos(radians(site.coordinates[1])) *
      Math.sin(dLng / 2) ** 2;
  return Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function loadFeed(ctx: IntegrationContext, call: ProviderCallContext): Promise<UkAirFeed> {
  return ctx.cache.withCache(
    "current-site-levels:v1",
    120,
    async (signal) => {
      const response = await ctx.http.getResponse<string>(ENDPOINT, {
        signal,
        timeoutMs: Math.max(250, call.deadlineAt - Date.now()),
        maxBytes: MAX_RESPONSE_BYTES,
        contentTypes: ["text/xml", "application/xml", "application/rss+xml"],
        redirect: "error",
      });
      if (response.status < 200 || response.status >= 300)
        throw new UkAirProviderError(`UK-AIR returned ${response.status}`, "upstream_failure");
      if (typeof response.body !== "string")
        throw new UkAirProviderError("UK-AIR RSS response is not text");
      return parseUkAirRss(response.body);
    },
    call.signal,
  );
}

function evidence(
  query: PointAirQualityQuery,
  feed: UkAirFeed,
  site: UkAirSiteLevel,
  distance: number,
): ProviderEvidence | null {
  const validUntil = new Date(Date.parse(site.observedAt) + VALIDITY_MS).toISOString();
  if (
    Date.parse(site.observedAt) > Date.parse(query.evaluatedAt) ||
    Date.parse(feed.publishedAt) > Date.parse(query.evaluatedAt) ||
    Date.parse(site.observedAt) > Date.parse(feed.publishedAt) ||
    Date.parse(feed.publishedAt) >= Date.parse(validUntil)
  )
    return null;
  const spatialSupportId = `UK-AIR-SITE-${site.id}`;
  const obsId = observationId({
    sourceId: SOURCE_ID,
    originRecordId: `${site.id}:${site.observedAt}`,
    spatialSupportId,
    modelRunId: null,
    evaluatedAt: site.observedAt,
  });
  return {
    observationId: obsId,
    providerId: "uk-air",
    sourceIds: [SOURCE_ID],
    dataAuthority: "official-agency",
    qualityStatus: "preliminary",
    basis: "ground",
    originRecords: [{ sourceId: SOURCE_ID, recordId: `${site.id}:${site.observedAt}` }],
    modelRunId: null,
    verticalLevel: null,
    series: [],
    publishedIndices: [
      {
        indexId: indexId({
          observationId: obsId,
          methodId: "uk-daqi",
          methodRevision: METHOD_REVISION,
          standardId: "uk-daqi-current",
          standardRevision: "uk-daqi-2026-04-13",
        }),
        methodId: "uk-daqi",
        methodRevision: METHOD_REVISION,
        claimedStandardId: "uk-daqi-current",
        value: site.value,
        displayValue: String(site.value),
        categoryId: site.categoryId,
        dominantPollutants: [],
      },
    ],
    observedAt: site.observedAt,
    forecastFor: null,
    publishedAt: feed.publishedAt,
    validUntil,
    spatial: {
      kind: "station",
      id: spatialSupportId,
      name: site.name,
      coordinates: site.coordinates,
      timeZone: "Europe/London",
      distanceMeters: distance,
      stationClass: "unknown",
      mobile: false,
      coversRequestedPoint: true,
      coverageMethod: "nearest-station",
    },
    sources: [{ ...source, url: site.sourceUrl }],
  };
}

export function createUkAirProvider(ctx: IntegrationContext): AirQualityProvider {
  return {
    id: "uk-air",
    sourceIds: [SOURCE_ID],
    priority: 100,
    timeoutMs: 3_000,
    capabilities: new Set(["current", "published-index"]),
    coverage: { countries: ["GB"], bbox: [-8.7, 49.8, 2.1, 60.9] },
    async getCurrent(query, call) {
      if (query.countryCode !== undefined && query.countryCode !== "GB") return [];
      const feed = await loadFeed(ctx, call);
      const nearest = feed.sites
        .map((site) => ({ site, distance: distanceMeters(query, site) }))
        .sort(
          (left, right) =>
            left.distance - right.distance || left.site.id.localeCompare(right.site.id),
        )[0];
      if (!nearest || nearest.distance > MAX_DISTANCE_METERS) return [];
      const item = evidence(query, feed, nearest.site, nearest.distance);
      return item ? [item] : [];
    },
  };
}
