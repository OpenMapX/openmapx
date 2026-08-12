import type { IntegrationContext } from "@openmapx/integration-framework";
import { isFirmsFeatureCollection } from "./firms-response.js";
import { type CachedLoadResult, loadWithFreshAndStaleCache } from "./source-cache.js";

const FIRMS_BASE = "https://firms.modaps.eosdis.nasa.gov/api/area/csv";
const FETCH_TIMEOUT_MS = 30_000;
const STALE_TTL_SECONDS = 6 * 60 * 60;

const CACHE_TTL: Record<FirmsDayRange, number> = {
  1: 300,
  2: 600,
  3: 900,
};

export function firmsFreshTtlSeconds(dayRange: FirmsDayRange): number {
  return CACHE_TTL[dayRange];
}

export type FirmsSource = "VIIRS_SNPP_NRT" | "MODIS_NRT";
export type FirmsDayRange = 1 | 2 | 3;

export interface FireFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    latitude: number;
    longitude: number;
    brightness: number;
    frp: number;
    confidence: string;
    satellite: string;
    acqDate: string;
    acqTime: string;
    dayNight: string;
    ageMs: number;
    source: string;
  };
}

export interface FireFeatureCollection {
  type: "FeatureCollection";
  features: FireFeature[];
}

export function parseAcqDateTime(date: string, time: string): number {
  const h = time.padStart(4, "0").slice(0, 2);
  const m = time.padStart(4, "0").slice(2, 4);
  return new Date(`${date}T${h}:${m}:00Z`).getTime();
}

function canonicalAcqTime(time: string): string {
  return time.padStart(4, "0");
}

function isCanonicalDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(milliseconds) && new Date(milliseconds).toISOString().slice(0, 10) === value
  );
}

function isRequiredFiniteCell(
  value: string | undefined,
  minimum: number,
  maximum: number,
): boolean {
  if (value === undefined || value.trim() === "") return false;
  const number = Number(value);
  return Number.isFinite(number) && number >= minimum && number <= maximum;
}

function isDeliberatelyFilteredConfidence(confidence: string, source: FirmsSource): boolean {
  if (source === "VIIRS_SNPP_NRT") return confidence === "low" || confidence === "l";
  return /^\d{1,2}$/.test(confidence) && Number(confidence) < 50;
}

function hasValidRetainedConfidence(confidence: string, source: FirmsSource): boolean {
  if (source === "VIIRS_SNPP_NRT") {
    return (
      confidence === "nominal" || confidence === "high" || confidence === "n" || confidence === "h"
    );
  }
  return /^(?:[5-9]\d|100)$/.test(confidence);
}

function validateFirmsCsvPayload(csv: string, source: FirmsSource): void {
  const trimmed = csv.trim();
  if (!trimmed) throw new Error("Invalid FIRMS CSV response");

  const lines = trimmed.split("\n");
  const headers = lines[0].split(",").map((header) => header.trim());
  const brightnessHeader = source === "VIIRS_SNPP_NRT" ? "bright_ti4" : "brightness";
  const requiredHeaders = [
    "latitude",
    "longitude",
    brightnessHeader,
    "acq_date",
    "acq_time",
    "satellite",
    "confidence",
    "frp",
    "daynight",
  ];
  if (
    requiredHeaders.some(
      (header) =>
        headers.indexOf(header) === -1 || headers.indexOf(header) !== headers.lastIndexOf(header),
    )
  ) {
    throw new Error("Invalid FIRMS CSV response");
  }

  const index = Object.fromEntries(
    requiredHeaders.map((header) => [header, headers.indexOf(header)]),
  );
  for (let lineIndex = 1; lineIndex < lines.length; lineIndex++) {
    const columns = lines[lineIndex].split(",");
    if (columns.length < headers.length) throw new Error("Invalid FIRMS CSV response");
    const cell = (header: string) => columns[index[header]]?.trim();
    const confidence = cell("confidence") ?? "";
    if (isDeliberatelyFilteredConfidence(confidence, source)) continue;

    const date = cell("acq_date") ?? "";
    const time = canonicalAcqTime(cell("acq_time") ?? "");
    if (
      !isRequiredFiniteCell(cell("latitude"), -90, 90) ||
      !isRequiredFiniteCell(cell("longitude"), -180, 180) ||
      !isRequiredFiniteCell(cell(brightnessHeader), 0, Number.POSITIVE_INFINITY) ||
      !isRequiredFiniteCell(cell("frp"), 0, Number.POSITIVE_INFINITY) ||
      !hasValidRetainedConfidence(confidence, source) ||
      !isCanonicalDate(date) ||
      !/^(?:[01]\d|2[0-3])[0-5]\d$/.test(time) ||
      !(cell("satellite") ?? "") ||
      (cell("daynight") !== "D" && cell("daynight") !== "N")
    ) {
      throw new Error("Invalid FIRMS CSV response");
    }
  }
}

export function csvToGeoJSON(csv: string, source: FirmsSource): FireFeatureCollection {
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return { type: "FeatureCollection", features: [] };

  const headers = lines[0].split(",").map((h) => h.trim());
  const now = Date.now();
  const features: FireFeature[] = [];

  const latIdx = headers.indexOf("latitude");
  const lngIdx = headers.indexOf("longitude");
  const dateIdx = headers.indexOf("acq_date");
  const timeIdx = headers.indexOf("acq_time");
  const confIdx = headers.indexOf("confidence");
  const satIdx = headers.indexOf("satellite");
  const frpIdx = headers.indexOf("frp");
  const dnIdx = headers.indexOf("daynight");
  const brightIdx =
    headers.indexOf("bright_ti4") !== -1
      ? headers.indexOf("bright_ti4")
      : headers.indexOf("brightness");

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",");
    if (cols.length < headers.length) continue;

    const lat = Number.parseFloat(cols[latIdx]);
    const lng = Number.parseFloat(cols[lngIdx]);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    const confidence = cols[confIdx]?.trim() ?? "";
    if (source.startsWith("VIIRS")) {
      if (confidence === "low" || confidence === "l") continue;
    } else {
      const confNum = Number.parseInt(confidence, 10);
      if (!Number.isNaN(confNum) && confNum < 50) continue;
    }

    const acqDate = cols[dateIdx]?.trim() ?? "";
    const acqTime = canonicalAcqTime(cols[timeIdx]?.trim() ?? "");
    const acqMs = parseAcqDateTime(acqDate, acqTime);
    const frp = Number.parseFloat(cols[frpIdx] ?? "0") || 0;
    const brightness = Number.parseFloat(cols[brightIdx] ?? "0") || 0;

    features.push({
      type: "Feature",
      geometry: { type: "Point", coordinates: [lng, lat] },
      properties: {
        latitude: lat,
        longitude: lng,
        brightness,
        frp,
        confidence,
        satellite: cols[satIdx]?.trim() ?? "",
        acqDate,
        acqTime,
        dayNight: cols[dnIdx]?.trim() ?? "",
        ageMs: now - acqMs,
        source,
      },
    });
  }

  return { type: "FeatureCollection", features };
}

export async function loadFirms(
  ctx: IntegrationContext,
  input: { dayRange: FirmsDayRange; source: FirmsSource },
): Promise<CachedLoadResult<FireFeatureCollection>> {
  const mapKey = ctx.config.firmsApiKey as string | undefined;
  if (!mapKey) throw new Error("FIRMS map key not configured");

  const result = await loadWithFreshAndStaleCache(ctx, {
    key: `fire:${input.source}:${input.dayRange}`,
    freshTtlSeconds: CACHE_TTL[input.dayRange],
    staleTtlSeconds: STALE_TTL_SECONDS,
    load: async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

      try {
        const url = `${FIRMS_BASE}/${mapKey}/${input.source}/world/${input.dayRange}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) {
          ctx.log.warn(`FIRMS API returned ${response.status}`);
          throw new Error(`FIRMS API returned ${response.status}`);
        }

        const csv = await response.text();
        validateFirmsCsvPayload(csv, input.source);
        const collection = csvToGeoJSON(csv, input.source);
        if (!isFirmsFeatureCollection(collection, input.source)) {
          throw new Error("Invalid FIRMS CSV response");
        }
        return collection;
      } finally {
        clearTimeout(timer);
      }
    },
  });

  return result;
}
