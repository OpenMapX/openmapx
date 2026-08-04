import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fetchWithRedirects, haversineMeters, USER_AGENT } from "@openmapx/core";
import { parseCsvRecords } from "@openmapx/mobility-formats";
import { strFromU8, unzipSync } from "fflate";

const SERVICE_POINTS_PAGE =
  "https://data.opentransportdata.swiss/en/dataset/service-points-actual-date";
const TRAFFIC_POINTS_PAGE = "https://data.opentransportdata.swiss/en/dataset/traffic-point-v2";
const STOP_POINT_PAGE = "https://data.opentransportdata.swiss/en/dataset/stop-point-v2";
const PLATFORM_PAGE = "https://data.opentransportdata.swiss/en/dataset/platform-v2";
const REFERENCE_POINT_PAGE = "https://data.opentransportdata.swiss/en/dataset/reference-point-v2";
const CONTACT_POINT_PAGE = "https://data.opentransportdata.swiss/en/dataset/contact-point-v2";
const TOILET_PAGE = "https://data.opentransportdata.swiss/en/dataset/toilet-v2";
const PARKING_LOT_PAGE = "https://data.opentransportdata.swiss/en/dataset/parking-lot-v2";
const RELATION_PAGE = "https://data.opentransportdata.swiss/en/dataset/relation-v2";

const SERVICE_POINTS_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/c8ed76a6-2960-4529-af6e-069a72c47268/resource/e2d5dcf4-42b2-4f2c-a4cf-044681ad0088/download/actual-date-swiss-service-point-2026-06-30.csv.zip";
const TRAFFIC_POINTS_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/b06d90be-91c6-440e-ab97-09f579d2fad0/resource/db4f3dd4-1d44-4e4e-9b21-2b43f0b2ea0d/download/actual-date-world-traffic-point.csv";
const STOP_POINT_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/e73d185a-e445-450f-9800-f485c7721a37/resource/c36afccb-9e93-41f2-a698-5c96c67ba6df/download/actual-date-stop-point.csv";
const PLATFORM_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/8e5931a6-b4aa-456a-9be4-498f28168861/resource/9e46026e-26ca-4ac9-b6b2-02aa3867b80a/download/actual-date-platform.csv";
const REFERENCE_POINT_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/11e86379-d543-40cc-9d58-11fc805946c1/resource/e4adc9a6-1205-4dc4-bd37-1a8716e4c040/download/actual-date-reference-point.csv";
const CONTACT_POINT_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/4deb3709-fda7-42b1-ba0a-b8d303330382/resource/b180660c-e2d8-477f-883b-ac0190723316/download/actual-date-contact-point.csv";
const TOILET_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/bc740b09-42ba-425b-9986-490d8938135c/resource/979d63af-8ae5-4dd7-8c38-e6bfce463fd9/download/actual-date-toilet.csv";
const PARKING_LOT_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/917db6c8-e240-4846-855f-fcc02856600e/resource/51fd8fb8-e978-45ea-b41f-1f60f22a2fa3/download/actual-date-parking-lot.csv";
const RELATION_FALLBACK_URL =
  "https://data.opentransportdata.swiss/dataset/fbc9efa2-eeb1-4d17-b94d-8b49e699149d/resource/628a823c-ba5d-4f7b-886b-144d28a34ca2/download/actual-date-relation.csv";
const GO_REALTIME_URL =
  "https://data.opentransportdata.swiss/dataset/27aba9bd-59ed-4d7c-bc71-a3813d1d1799/resource/83b8b8d0-e345-453b-857e-1192d48c4c64/download/go-realtime.csv";
const GO_SIRI_SX_URL =
  "https://data.opentransportdata.swiss/dataset/b3ac097b-ff72-4a1f-9d69-76e72962d769/resource/a8312f3a-18a6-4e92-9906-bbb623a24369/download/go-siri-sx.csv";
const OCCUPANCY_FORECAST_JSON_PERMALINK =
  "https://data.opentransportdata.swiss/en/dataset/occupancy-forecast-json-dataset/permalink";

const REFRESH_MS = 12 * 60 * 60 * 1000;
const DOWNLOAD_URL_REFRESH_MS = 24 * 60 * 60 * 1000;
const OCCUPANCY_FORECAST_REFRESH_MS = 6 * 60 * 60 * 1000;
const SWISS_REDIRECT_HOSTS = [
  "opentransportdata.swiss",
  "*.opentransportdata.swiss",
  "83025b28472d6aa2bf5ae59f3724aa78.eu.r2.cloudflarestorage.com",
];
const SWISS_ARCHIVE_TOKEN_RE = /^[0-9A-Za-z][0-9A-Za-z_-]{0,63}$/;
const MAX_OCCUPANCY_ZIP_BYTES = 64 * 1024 * 1024;
const MAX_OCCUPANCY_ENTRY_BYTES = 32 * 1024 * 1024;

/**
 * Cap for the first inflated member of a Swiss ZIP dataset. The archive's
 * declared size can be understated by a crafted file, but extracting only one
 * member prevents the ordinary multi-member memory blowup.
 */
const MAX_MEMBER_BYTES = 256 * 1024 * 1024;

export interface SwissServicePoint {
  abbreviation?: string;
  businessOrganisation?: string;
  businessOrganisationDescription?: string;
  cantonName?: string;
  categories: string[];
  didok?: string;
  isoCountryCode?: string;
  lat: number;
  lng: number;
  localityName?: string;
  meansOfTransport: string[];
  municipalityName?: string;
  name: string;
  servicePointSloid: string;
  stopPointType?: string;
  uicCountryCode?: string;
}

export interface SwissTrafficPoint {
  designation?: string;
  designationOfficial?: string;
  lat: number;
  lng: number;
  parentSloid?: string;
  parentSloidServicePoint: string;
  sloid: string;
  trafficPointElementType?: string;
}

export interface SwissFlatCsvRecord {
  [key: string]: string;
}

export interface SwissStopDatasets {
  contactPointsByServicePoint: Map<string, SwissFlatCsvRecord[]>;
  didokToServicePointSloid: Map<string, string>;
  parkingLotsByServicePoint: Map<string, SwissFlatCsvRecord[]>;
  platformAccessibilityBySloid: Map<string, SwissFlatCsvRecord>;
  referencePointsByServicePoint: Map<string, SwissFlatCsvRecord[]>;
  relationsByServicePoint: Map<string, SwissFlatCsvRecord[]>;
  servicePoints: SwissServicePoint[];
  servicePointsBySloid: Map<string, SwissServicePoint>;
  stopPointAccessibilityByServicePoint: Map<string, SwissFlatCsvRecord[]>;
  toiletsByServicePoint: Map<string, SwissFlatCsvRecord[]>;
  trafficPointsByParentSloid: Map<string, SwissTrafficPoint[]>;
  trafficPointsByServicePoint: Map<string, SwissTrafficPoint[]>;
  trafficPointsBySloid: Map<string, SwissTrafficPoint>;
}

export interface SwissBusinessOrganisation {
  abbreviation?: string;
  comment?: string;
  description?: string;
  hasRealtimeData: boolean;
  hasSituationExchangeData: boolean;
  organisationNumber?: string;
  participantRef?: string;
  sboid?: string;
  sboidOwnerRef?: string;
  source?: string;
}

export interface SwissBusinessOrganisationDatasets {
  byAbbreviation: Map<string, SwissBusinessOrganisation>;
  byOrganisationNumber: Map<string, SwissBusinessOrganisation>;
  byParticipantRef: Map<string, SwissBusinessOrganisation>;
  bySboid: Map<string, SwissBusinessOrganisation>;
  entries: SwissBusinessOrganisation[];
}

export interface SwissOccupancyForecastFareClassLevel {
  fareClass?: string;
  occupancyLevel?: string;
}

export interface SwissOccupancyForecastSection {
  arrivalDayShift?: number;
  arrivalStationId?: string;
  arrivalStationName?: string;
  arrivalTime?: string;
  departureDayShift?: number;
  departureStationId?: string;
  departureStationName?: string;
  departureTime?: string;
  destinationStationId?: string;
  destinationStationName?: string;
  expectedArrivalOccupancies?: SwissOccupancyForecastFareClassLevel[];
  expectedDepartureOccupancies?: SwissOccupancyForecastFareClassLevel[];
}

export interface SwissOccupancyForecastTrain {
  journeyRef?: string;
  lineRef?: string;
  sections?: SwissOccupancyForecastSection[];
  trainNumber?: string;
}

export interface SwissOccupancyForecastDataset {
  dataSource?: string;
  lastUpdated?: string;
  opDate?: string;
  operatorRef?: string;
  timeToLive?: number;
  trains?: SwissOccupancyForecastTrain[];
  version?: string;
}

let stopDatasetsCache: { expiresAt: number; value: SwissStopDatasets } | null = null;
let businessOrganisationCache: {
  expiresAt: number;
  value: SwissBusinessOrganisationDatasets;
} | null = null;
const latestDownloadUrlCache = new Map<string, { expiresAt: number; url: string }>();
const occupancyDatasetCache = new Map<
  string,
  { expiresAt: number; value: SwissOccupancyForecastDataset | null }
>();
let occupancyZipCache: { expiresAt: number; path: string } | null = null;
let occupancyZipLoading: Promise<string | null> | null = null;

function normalizeWhitespace(value: string): string {
  return value.toLowerCase().replace(/\s+/g, " ").trim();
}

function normalizeLookupKey(value: string | undefined): string | null {
  const normalized = String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

function pushGrouped(
  map: Map<string, SwissFlatCsvRecord[]>,
  key: string | undefined,
  value: SwissFlatCsvRecord,
): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function pushTrafficPoint(
  map: Map<string, SwissTrafficPoint[]>,
  key: string | undefined,
  value: SwissTrafficPoint,
): void {
  if (!key) return;
  const existing = map.get(key);
  if (existing) {
    existing.push(value);
  } else {
    map.set(key, [value]);
  }
}

function parseBooleanFlag(value: string | undefined): boolean | undefined {
  if (!value) return undefined;
  if (value === "YES" || value === "true" || value === "TRUE") return true;
  if (value === "NO" || value === "false" || value === "FALSE") return false;
  return undefined;
}

function splitCsvList(value: string | undefined): string[] {
  return String(value ?? "")
    .split(/[;,]/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function extractOrganisationNumber(value: string | undefined): string | undefined {
  const match = String(value ?? "").match(/^85:(\d+)(?::\d+)?$/);
  return match?.[1];
}

function extractServicePointSloid(ref: string | undefined): string | null {
  if (!ref) return null;
  if (/^\d+$/.test(ref)) return null;
  const parts = ref.split(":");
  if (parts.length < 4) return null;
  if (parts[0] !== "ch" || parts[1] !== "1" || parts[2] !== "sloid") return null;
  return parts.slice(0, 4).join(":");
}

function extractDidok(ref: string | undefined): string | null {
  if (!ref) return null;
  if (/^\d+$/.test(ref)) return ref;
  if (ref.startsWith("ch:") && /^\d+$/.test(ref.slice(3))) return ref.slice(3);
  return null;
}

function trustedSwissRedirectHosts(url: string): string[] {
  return [new URL(url).hostname, ...SWISS_REDIRECT_HOSTS];
}

async function fetchText(url: string): Promise<string> {
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: {
      "Accept-Encoding": "gzip, br, deflate",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 30_000,
  });
  if (!response.ok) {
    throw new Error(`Swiss dataset request failed (${response.status}) for ${url}`);
  }
  return response.text();
}

async function fetchArrayBuffer(url: string): Promise<ArrayBuffer> {
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: {
      "Accept-Encoding": "gzip, br, deflate",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 60_000,
  });
  if (!response.ok) {
    throw new Error(`Swiss dataset request failed (${response.status}) for ${url}`);
  }
  return response.arrayBuffer();
}

async function downloadToTempFile(url: string, prefix: string): Promise<string> {
  const response = await fetchWithRedirects(url, {
    allowedRedirectHosts: trustedSwissRedirectHosts(url),
    follow203Redirect: true,
    headers: {
      "Accept-Encoding": "gzip, br, deflate",
      "User-Agent": USER_AGENT,
    },
    timeoutMs: 120_000,
  });
  if (!response.ok) {
    throw new Error(`Swiss dataset request failed (${response.status}) for ${url}`);
  }
  if (!response.body) {
    throw new Error(`Swiss dataset request returned no body for ${url}`);
  }

  const dir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const filePath = join(dir, "dataset.zip");
  await pipeline(
    Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
    createWriteStream(filePath),
  );
  return filePath;
}

export async function extractZipEntryText(
  zipPath: string,
  entryName: string,
): Promise<string | null> {
  try {
    const { size } = await stat(zipPath);
    if (size > MAX_OCCUPANCY_ZIP_BYTES) return null;
    const files = unzipSync(new Uint8Array(await readFile(zipPath)));
    const entry = files[entryName];
    if (!entry || entry.length > MAX_OCCUPANCY_ENTRY_BYTES) return null;
    return strFromU8(entry).replace(/^\uFEFF/, "") || null;
  } catch {
    return null;
  }
}

async function ensureSwissOccupancyZipPath(): Promise<string | null> {
  if (occupancyZipCache && occupancyZipCache.expiresAt > Date.now()) {
    return occupancyZipCache.path;
  }
  if (occupancyZipLoading) {
    return occupancyZipLoading;
  }

  occupancyZipLoading = (async () => {
    const path = await downloadToTempFile(OCCUPANCY_FORECAST_JSON_PERMALINK, "swiss-occupancy");
    const previous = occupancyZipCache;
    occupancyZipCache = {
      expiresAt: Date.now() + OCCUPANCY_FORECAST_REFRESH_MS,
      path,
    };
    if (previous?.path && previous.path !== path) {
      await rm(previous.path, { force: true }).catch(() => {});
      await rm(join(previous.path, ".."), { force: true, recursive: true }).catch(() => {});
    }
    return path;
  })()
    .catch((error) => {
      occupancyZipLoading = null;
      throw error;
    })
    .finally(() => {
      occupancyZipLoading = null;
    });

  return occupancyZipLoading;
}

function unzipFirstCsv(buffer: ArrayBuffer): string {
  let picked: string | undefined;
  const files = unzipSync(new Uint8Array(buffer), {
    filter: (file) => {
      if (picked) return false;
      if (file.originalSize > MAX_MEMBER_BYTES) {
        throw new Error(`ZIP member ${file.name} exceeds max ${MAX_MEMBER_BYTES} bytes`);
      }
      picked = file.name;
      return true;
    },
  });
  const firstFile = picked ? files[picked] : undefined;
  if (!firstFile) throw new Error("Swiss ZIP dataset was empty");
  return strFromU8(firstFile).replace(/^\uFEFF/, "");
}

async function resolveLatestDownloadUrl(
  cacheKey: string,
  pageUrl: string,
  fallbackUrl: string,
  extension: ".csv.zip" | ".csv" | ".json",
  preferredName?: string,
): Promise<string> {
  const cached = latestDownloadUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.url;
  }
  try {
    const html = await fetchText(pageUrl);
    const matches = [...html.matchAll(/href=["']([^"']+)["']/gi)]
      .map((match) => match[1])
      .filter(
        (href): href is string =>
          typeof href === "string" && href.toLowerCase().includes(extension),
      )
      .sort((left, right) => {
        const leftLower = left.toLowerCase();
        const rightLower = right.toLowerCase();
        const leftScore =
          (leftLower.includes("/download/") ? 1 : 0) +
          (preferredName && leftLower.includes(preferredName.toLowerCase()) ? 2 : 0);
        const rightScore =
          (rightLower.includes("/download/") ? 1 : 0) +
          (preferredName && rightLower.includes(preferredName.toLowerCase()) ? 2 : 0);
        return rightScore - leftScore;
      });
    const href = matches[0];
    if (href) {
      const url = new URL(href, pageUrl).toString();
      latestDownloadUrlCache.set(cacheKey, {
        expiresAt: Date.now() + DOWNLOAD_URL_REFRESH_MS,
        url,
      });
      return url;
    }
  } catch {
    // fall through to the last-known URL
  }
  latestDownloadUrlCache.set(cacheKey, {
    expiresAt: Date.now() + DOWNLOAD_URL_REFRESH_MS,
    url: fallbackUrl,
  });
  return fallbackUrl;
}

async function fetchZipCsv(
  pageKey: string,
  pageUrl: string,
  fallbackUrl: string,
): Promise<SwissFlatCsvRecord[]> {
  const downloadUrl = await resolveLatestDownloadUrl(pageKey, pageUrl, fallbackUrl, ".csv.zip");
  const zipped = await fetchArrayBuffer(downloadUrl);
  return parseCsvRecords(unzipFirstCsv(zipped), { delimiter: ";" });
}

async function fetchSemicolonCsv(url: string): Promise<SwissFlatCsvRecord[]> {
  const text = await fetchText(url);
  return parseCsvRecords(text, { delimiter: ";" });
}

async function fetchCsv(
  pageKey: string,
  pageUrl: string,
  fallbackUrl: string,
): Promise<SwissFlatCsvRecord[]> {
  const downloadUrl = await resolveLatestDownloadUrl(
    pageKey,
    pageUrl,
    fallbackUrl,
    ".csv",
    "actual-date",
  );
  return parseCsvRecords(await fetchText(downloadUrl), { delimiter: ";" });
}

function buildServicePoints(records: SwissFlatCsvRecord[]): {
  servicePoints: SwissServicePoint[];
  servicePointsBySloid: Map<string, SwissServicePoint>;
  didokToServicePointSloid: Map<string, string>;
} {
  const bySloid = new Map<string, SwissServicePoint>();
  const didokMap = new Map<string, string>();
  for (const record of records) {
    const servicePointSloid = record.sloid;
    if (!servicePointSloid) continue;
    const lat = Number(record.wgs84North);
    const lng = Number(record.wgs84East);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const existing = bySloid.get(servicePointSloid);
    const means = splitCsvList(record.meansOfTransport);
    if (existing) {
      const mergedModes = new Set([...existing.meansOfTransport, ...means]);
      existing.meansOfTransport = [...mergedModes];
      if (!existing.name && record.designationOfficial) existing.name = record.designationOfficial;
      continue;
    }

    bySloid.set(servicePointSloid, {
      abbreviation: record.businessOrganisationAbbreviationDe || undefined,
      businessOrganisation: record.businessOrganisation || undefined,
      businessOrganisationDescription: record.businessOrganisationDescriptionDe || undefined,
      cantonName: record.cantonName || undefined,
      categories: splitCsvList(record.categories),
      didok: record.number || undefined,
      isoCountryCode: record.isoCountryCode || undefined,
      lat,
      lng,
      localityName: record.localityName || undefined,
      meansOfTransport: means,
      municipalityName: record.municipalityName || undefined,
      name: record.designationOfficial || record.designationLong || servicePointSloid,
      servicePointSloid,
      stopPointType: record.stopPointType || undefined,
      uicCountryCode: record.uicCountryCode || undefined,
    });
    if (record.number) {
      didokMap.set(record.number, servicePointSloid);
    }
  }
  return {
    didokToServicePointSloid: didokMap,
    servicePoints: [...bySloid.values()],
    servicePointsBySloid: bySloid,
  };
}

function buildTrafficPoints(records: SwissFlatCsvRecord[]) {
  const bySloid = new Map<string, SwissTrafficPoint>();
  const byParentSloid = new Map<string, SwissTrafficPoint[]>();
  const byServicePoint = new Map<string, SwissTrafficPoint[]>();

  for (const record of records) {
    const sloid = record.sloid;
    const parentSloidServicePoint = record.parentSloidServicePoint;
    const lat = Number(record.wgs84North);
    const lng = Number(record.wgs84East);
    if (!sloid || !parentSloidServicePoint || !Number.isFinite(lat) || !Number.isFinite(lng)) {
      continue;
    }
    const trafficPoint: SwissTrafficPoint = {
      designation: record.designation || undefined,
      designationOfficial: record.designationOfficial || undefined,
      lat,
      lng,
      parentSloid: record.parentSloid || undefined,
      parentSloidServicePoint,
      sloid,
      trafficPointElementType: record.trafficPointElementType || undefined,
    };
    bySloid.set(sloid, trafficPoint);
    pushTrafficPoint(byParentSloid, trafficPoint.parentSloid, trafficPoint);
    pushTrafficPoint(byServicePoint, parentSloidServicePoint, trafficPoint);
  }

  return {
    trafficPointsByParentSloid: byParentSloid,
    trafficPointsByServicePoint: byServicePoint,
    trafficPointsBySloid: bySloid,
  };
}

export function resolveSwissStopIdentity(
  rawRef: string,
  datasets: SwissStopDatasets,
): {
  didok?: string;
  servicePointSloid?: string;
  stopPointSloid?: string;
} {
  const extractedDidok = extractDidok(rawRef) ?? undefined;
  const servicePointFromDidok = extractedDidok
    ? datasets.didokToServicePointSloid.get(extractedDidok)
    : undefined;
  const servicePointFromSloid = extractServicePointSloid(rawRef) ?? undefined;
  const servicePointSloid = servicePointFromDidok ?? servicePointFromSloid;
  const derivedDidok = servicePointSloid
    ? datasets.servicePointsBySloid.get(servicePointSloid)?.didok
    : undefined;
  const stopPointSloid =
    rawRef.startsWith("ch:1:sloid:") && rawRef !== servicePointFromSloid ? rawRef : undefined;
  return {
    ...((extractedDidok ?? derivedDidok) ? { didok: extractedDidok ?? derivedDidok } : {}),
    servicePointSloid,
    ...(stopPointSloid ? { stopPointSloid } : {}),
  };
}

export async function loadSwissStopDatasets(): Promise<SwissStopDatasets> {
  if (stopDatasetsCache && stopDatasetsCache.expiresAt > Date.now()) {
    return stopDatasetsCache.value;
  }

  const [
    servicePointRecords,
    trafficPointRecords,
    stopPointRecords,
    platformRecords,
    referencePointRecords,
    contactPointRecords,
    toiletRecords,
    parkingLotRecords,
    relationRecords,
  ] = await Promise.all([
    fetchZipCsv("service-points", SERVICE_POINTS_PAGE, SERVICE_POINTS_FALLBACK_URL),
    fetchCsv("traffic-points", TRAFFIC_POINTS_PAGE, TRAFFIC_POINTS_FALLBACK_URL),
    fetchCsv("stop-points", STOP_POINT_PAGE, STOP_POINT_FALLBACK_URL),
    fetchCsv("platforms", PLATFORM_PAGE, PLATFORM_FALLBACK_URL),
    fetchCsv("reference-points", REFERENCE_POINT_PAGE, REFERENCE_POINT_FALLBACK_URL),
    fetchCsv("contact-points", CONTACT_POINT_PAGE, CONTACT_POINT_FALLBACK_URL),
    fetchCsv("toilets", TOILET_PAGE, TOILET_FALLBACK_URL),
    fetchCsv("parking-lots", PARKING_LOT_PAGE, PARKING_LOT_FALLBACK_URL),
    fetchCsv("relations", RELATION_PAGE, RELATION_FALLBACK_URL),
  ]);

  const { servicePoints, servicePointsBySloid, didokToServicePointSloid } =
    buildServicePoints(servicePointRecords);
  const { trafficPointsByParentSloid, trafficPointsByServicePoint, trafficPointsBySloid } =
    buildTrafficPoints(trafficPointRecords);

  const stopPointAccessibilityByServicePoint = new Map<string, SwissFlatCsvRecord[]>();
  for (const record of stopPointRecords) {
    const servicePointSloid = extractServicePointSloid(record.sloid);
    pushGrouped(stopPointAccessibilityByServicePoint, servicePointSloid ?? undefined, record);
  }

  const platformAccessibilityBySloid = new Map<string, SwissFlatCsvRecord>();
  for (const record of platformRecords) {
    if (record.sloid) {
      platformAccessibilityBySloid.set(record.sloid, record);
    }
  }

  const referencePointsByServicePoint = new Map<string, SwissFlatCsvRecord[]>();
  for (const record of referencePointRecords) {
    pushGrouped(referencePointsByServicePoint, record.parentSloidServicePoint, record);
  }

  const contactPointsByServicePoint = new Map<string, SwissFlatCsvRecord[]>();
  for (const record of contactPointRecords) {
    pushGrouped(contactPointsByServicePoint, record.parentSloidServicePoint, record);
  }

  const toiletsByServicePoint = new Map<string, SwissFlatCsvRecord[]>();
  for (const record of toiletRecords) {
    pushGrouped(toiletsByServicePoint, record.parentSloidServicePoint, record);
  }

  const parkingLotsByServicePoint = new Map<string, SwissFlatCsvRecord[]>();
  for (const record of parkingLotRecords) {
    pushGrouped(parkingLotsByServicePoint, record.parentSloidServicePoint, record);
  }

  const relationsByServicePoint = new Map<string, SwissFlatCsvRecord[]>();
  for (const record of relationRecords) {
    pushGrouped(relationsByServicePoint, record.parentSloidServicePoint, record);
  }

  const datasets: SwissStopDatasets = {
    contactPointsByServicePoint,
    didokToServicePointSloid,
    parkingLotsByServicePoint,
    platformAccessibilityBySloid,
    referencePointsByServicePoint,
    relationsByServicePoint,
    servicePoints,
    servicePointsBySloid,
    stopPointAccessibilityByServicePoint,
    toiletsByServicePoint,
    trafficPointsByParentSloid,
    trafficPointsByServicePoint,
    trafficPointsBySloid,
  };

  stopDatasetsCache = {
    expiresAt: Date.now() + REFRESH_MS,
    value: datasets,
  };
  return datasets;
}

function registerBusinessOrganisationLookup(
  map: Map<string, SwissBusinessOrganisation>,
  key: string | undefined,
  value: SwissBusinessOrganisation,
): void {
  const normalized = normalizeLookupKey(key);
  if (!normalized || map.has(normalized)) return;
  map.set(normalized, value);
}

function mergeBusinessOrganisationRecords(
  base: SwissBusinessOrganisation | undefined,
  next: Partial<SwissBusinessOrganisation>,
): SwissBusinessOrganisation {
  return {
    abbreviation: next.abbreviation || base?.abbreviation,
    comment: next.comment || base?.comment,
    description: next.description || base?.description,
    hasRealtimeData: base?.hasRealtimeData === true || next.hasRealtimeData === true,
    hasSituationExchangeData:
      base?.hasSituationExchangeData === true || next.hasSituationExchangeData === true,
    organisationNumber: next.organisationNumber || base?.organisationNumber,
    participantRef: next.participantRef || base?.participantRef,
    sboid: next.sboid || base?.sboid,
    sboidOwnerRef: next.sboidOwnerRef || base?.sboidOwnerRef,
    source: next.source || base?.source,
  };
}

function canonicalBusinessOrganisationKey(
  record: Partial<SwissBusinessOrganisation>,
): string | null {
  return (
    normalizeLookupKey(record.sboid) ??
    normalizeLookupKey(record.organisationNumber) ??
    normalizeLookupKey(record.participantRef) ??
    normalizeLookupKey(record.abbreviation) ??
    normalizeLookupKey(record.description)
  );
}

export async function loadSwissBusinessOrganisationDatasets(): Promise<SwissBusinessOrganisationDatasets> {
  if (businessOrganisationCache && businessOrganisationCache.expiresAt > Date.now()) {
    return businessOrganisationCache.value;
  }

  let realtimeRecords: SwissFlatCsvRecord[] = [];
  let situationExchangeRecords: SwissFlatCsvRecord[] = [];
  try {
    [realtimeRecords, situationExchangeRecords] = await Promise.all([
      fetchSemicolonCsv(GO_REALTIME_URL),
      fetchSemicolonCsv(GO_SIRI_SX_URL),
    ]);
  } catch {
    realtimeRecords = [];
    situationExchangeRecords = [];
  }

  const merged = new Map<string, SwissBusinessOrganisation>();
  for (const record of realtimeRecords) {
    const partial: Partial<SwissBusinessOrganisation> = {
      abbreviation: record.abbreviationEn || undefined,
      comment: record.comment || undefined,
      description: record.descriptionEn || undefined,
      hasRealtimeData: parseBooleanFlag(record.complete) !== false,
      organisationNumber: extractOrganisationNumber(record.vdvBetreiberId),
      sboid: record.sboid || undefined,
      source: record.source || undefined,
    };
    const key = canonicalBusinessOrganisationKey(partial);
    if (!key) continue;
    merged.set(key, mergeBusinessOrganisationRecords(merged.get(key), partial));
  }
  for (const record of situationExchangeRecords) {
    const partial: Partial<SwissBusinessOrganisation> = {
      abbreviation: record.abbreviationEn || undefined,
      comment: record.comment || undefined,
      description: record.descriptionEn || undefined,
      hasSituationExchangeData: true,
      organisationNumber: extractOrganisationNumber(record.vdvBetreiberId),
      participantRef: record.participantRef || undefined,
      sboid: record.sboid || undefined,
      sboidOwnerRef: record.sboidOwnerRef || undefined,
    };
    const key = canonicalBusinessOrganisationKey(partial);
    if (!key) continue;
    merged.set(key, mergeBusinessOrganisationRecords(merged.get(key), partial));
  }

  const datasets: SwissBusinessOrganisationDatasets = {
    byAbbreviation: new Map<string, SwissBusinessOrganisation>(),
    byOrganisationNumber: new Map<string, SwissBusinessOrganisation>(),
    byParticipantRef: new Map<string, SwissBusinessOrganisation>(),
    bySboid: new Map<string, SwissBusinessOrganisation>(),
    entries: [...merged.values()],
  };

  for (const entry of datasets.entries) {
    registerBusinessOrganisationLookup(datasets.byAbbreviation, entry.abbreviation, entry);
    const abbreviationRoot = entry.abbreviation?.split("-")[0];
    registerBusinessOrganisationLookup(datasets.byAbbreviation, abbreviationRoot, entry);
    registerBusinessOrganisationLookup(
      datasets.byOrganisationNumber,
      entry.organisationNumber,
      entry,
    );
    registerBusinessOrganisationLookup(datasets.byParticipantRef, entry.participantRef, entry);
    registerBusinessOrganisationLookup(datasets.bySboid, entry.sboid, entry);
    registerBusinessOrganisationLookup(datasets.bySboid, entry.sboidOwnerRef, entry);
  }

  businessOrganisationCache = {
    expiresAt: Date.now() + REFRESH_MS,
    value: datasets,
  };
  return datasets;
}

export async function loadSwissOccupancyForecastDataset(
  opDate: string,
  operatorRef: string,
): Promise<SwissOccupancyForecastDataset | null> {
  const normalizedDate = String(opDate).trim();
  const normalizedOperator = String(operatorRef).trim();
  if (!normalizedDate || !normalizedOperator) return null;
  if (
    !SWISS_ARCHIVE_TOKEN_RE.test(normalizedDate) ||
    !SWISS_ARCHIVE_TOKEN_RE.test(normalizedOperator)
  ) {
    return null;
  }

  const cacheKey = `${normalizedDate}:${normalizedOperator}`;
  const cached = occupancyDatasetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }

  const zipPath = await ensureSwissOccupancyZipPath().catch(() => null);
  if (!zipPath) {
    occupancyDatasetCache.set(cacheKey, {
      expiresAt: Date.now() + 5 * 60 * 1000,
      value: null,
    });
    return null;
  }

  const entryName = `${normalizedDate}/operator-${normalizedOperator}.json`;
  const text = await extractZipEntryText(zipPath, entryName);
  const parsed = text ? ((JSON.parse(text) as SwissOccupancyForecastDataset) ?? null) : null;

  occupancyDatasetCache.set(cacheKey, {
    expiresAt: Date.now() + OCCUPANCY_FORECAST_REFRESH_MS,
    value: parsed,
  });
  return parsed;
}

export async function searchSwissServicePoints(
  query: string,
  limit: number,
): Promise<SwissServicePoint[]> {
  const datasets = await loadSwissStopDatasets();
  const normalizedQuery = normalizeWhitespace(query);
  if (!normalizedQuery) return [];

  const scored = datasets.servicePoints
    .map((servicePoint) => {
      const haystack = normalizeWhitespace(
        [
          servicePoint.name,
          servicePoint.localityName,
          servicePoint.municipalityName,
          servicePoint.didok,
        ]
          .filter(Boolean)
          .join(" "),
      );
      let score = 0;
      if (haystack.startsWith(normalizedQuery)) score += 100;
      if (haystack.includes(normalizedQuery)) score += 50;
      if (servicePoint.name.toLowerCase() === query.toLowerCase()) score += 25;
      return { score, servicePoint };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.servicePoint.name.localeCompare(b.servicePoint.name))
    .slice(0, limit);

  return scored.map((entry) => entry.servicePoint);
}

export async function findSwissNearbyServicePoints(
  lat: number,
  lng: number,
  radiusMeters: number,
  limit = 80,
): Promise<SwissServicePoint[]> {
  const datasets = await loadSwissStopDatasets();
  return datasets.servicePoints
    .map((servicePoint) => ({
      distance: haversineMeters(lat, lng, servicePoint.lat, servicePoint.lng),
      servicePoint,
    }))
    .filter((entry) => entry.distance <= radiusMeters)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, limit)
    .map((entry) => entry.servicePoint);
}

export function hasSwissRealtimeOccupancy(record: SwissFlatCsvRecord): boolean {
  return parseBooleanFlag(record.placesAvailable) === true;
}
