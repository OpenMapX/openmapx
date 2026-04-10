import { type IntegrationContext, USER_AGENT } from "@openmapx/core";
import { XMLParser } from "fast-xml-parser";

const NOAA_URL = "https://api.weather.gov/alerts/active?status=actual&message_type=alert";
const ECCC_URL = "https://api.weather.gc.ca/collections/weather-alerts/items?f=json&limit=500";
const DWD_URL =
  "https://maps.dwd.de/geoserver/dwd/ows?service=WFS&version=2.0.0&request=GetFeature&typeName=dwd:Warnungen_Gemeinden_vereinigt&outputFormat=application/json&count=500";
const METEOALARM_FEED_URL = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-";

const FETCH_TIMEOUT_MS = 15_000;
const CACHE_TTL = 300; // 5 minutes

// European countries to fetch from MeteoAlarm (exclude DE — DWD covers Germany with polygons)
const METEOALARM_COUNTRIES = [
  "AT",
  "BE",
  "CH",
  "CZ",
  "DK",
  "ES",
  "FI",
  "FR",
  "GB",
  "GR",
  "HR",
  "HU",
  "IE",
  "IS",
  "IT",
  "LU",
  "NL",
  "NO",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
];

const COUNTRY_CENTROIDS: Record<string, [number, number]> = {
  AT: [14.55, 47.52],
  BE: [4.47, 50.5],
  CH: [8.23, 46.82],
  CZ: [15.47, 49.82],
  DK: [9.5, 56.26],
  ES: [-3.75, 40.46],
  FI: [25.75, 61.92],
  FR: [2.21, 46.23],
  GB: [-3.44, 55.38],
  GR: [21.82, 39.07],
  HR: [15.2, 45.1],
  HU: [19.5, 47.16],
  IE: [-8.24, 53.41],
  IS: [-19.02, 64.96],
  IT: [12.57, 41.87],
  LU: [6.13, 49.82],
  NL: [5.29, 52.13],
  NO: [8.47, 60.47],
  PL: [19.15, 51.92],
  PT: [-8.22, 39.4],
  RO: [24.97, 45.94],
  SE: [18.64, 60.13],
  SI: [14.99, 46.15],
  SK: [19.7, 48.64],
};

const METEOALARM_BATCH_SIZE = 8;

interface NormalizedFeature {
  type: "Feature";
  geometry: {
    type: string;
    coordinates: unknown;
  };
  properties: {
    id: string;
    title: string;
    severity: string;
    urgency: string;
    certainty: string;
    event: string;
    description: string | null;
    instruction: string | null;
    onset: string | null;
    expires: string | null;
    areaDesc: string;
    source: "noaa" | "eccc" | "dwd" | "meteoalarm";
    sourceUrl: string | null;
    geometryType: "polygon" | "point";
  };
}

interface FeatureCollection {
  type: "FeatureCollection";
  features: NormalizedFeature[];
}

const VALID_SEVERITIES = new Set(["Extreme", "Severe", "Moderate", "Minor", "Unknown"]);

function normalizeSeverity(raw: string | undefined | null): string {
  if (!raw) return "Unknown";
  const capitalized = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase();
  return VALID_SEVERITIES.has(capitalized) ? capitalized : "Unknown";
}

function isExpired(expires: string | null | undefined): boolean {
  if (!expires) return false;
  const t = new Date(expires).getTime();
  return !Number.isNaN(t) && t < Date.now();
}

async function fetchWithTimeout(url: string, headers?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { signal: controller.signal, headers });
  } finally {
    clearTimeout(timer);
  }
}

// NOAA Weather Alerts
async function fetchNOAA(log: IntegrationContext["log"]): Promise<NormalizedFeature[]> {
  const res = await fetchWithTimeout(NOAA_URL, {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  });
  if (!res.ok) {
    log.warn(`NOAA API returned ${res.status}`);
    return [];
  }

  const data = await res.json();
  const features: NormalizedFeature[] = [];

  for (const f of data.features ?? []) {
    // Drop alerts without geometry (zone-based)
    if (!f.geometry) continue;
    const p = f.properties;
    if (isExpired(p.expires)) continue;

    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        id: `noaa-${p.id || crypto.randomUUID()}`,
        title: p.headline || p.event || "Weather Alert",
        severity: normalizeSeverity(p.severity),
        urgency: p.urgency || "Unknown",
        certainty: p.certainty || "Unknown",
        event: p.event || "Unknown",
        description: p.description || null,
        instruction: p.instruction || null,
        onset: p.onset || p.effective || null,
        expires: p.expires || p.ends || null,
        areaDesc: p.areaDesc || "",
        source: "noaa",
        sourceUrl: p.web || null,
        geometryType: "polygon",
      },
    });
  }

  return features;
}

// ECCC (Environment and Climate Change Canada)
async function fetchECCC(log: IntegrationContext["log"]): Promise<NormalizedFeature[]> {
  const res = await fetchWithTimeout(ECCC_URL, { "User-Agent": USER_AGENT });
  if (!res.ok) {
    log.warn(`ECCC API returned ${res.status}`);
    return [];
  }

  const data = await res.json();
  const features: NormalizedFeature[] = [];

  for (const f of data.features ?? []) {
    if (!f.geometry) continue;
    const p = f.properties;
    if (isExpired(p.expiration_datetime || p.expires)) continue;

    const alertType = p.alert_type || p.status_en || "";
    const severity = alertType.toLowerCase().includes("warning")
      ? "Severe"
      : alertType.toLowerCase().includes("watch")
        ? "Moderate"
        : alertType.toLowerCase().includes("advisory") ||
            alertType.toLowerCase().includes("statement")
          ? "Minor"
          : "Unknown";

    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        id: `eccc-${f.id || p.identifier || crypto.randomUUID()}`,
        title: p.alert_name_en || p.alert_name_fr || alertType || "Weather Alert",
        severity,
        urgency: p.urgency || "Unknown",
        certainty: p.confidence_en || "Unknown",
        event: p.alert_name_en || p.alert_code || alertType || "Unknown",
        description: p.alert_text_en || p.alert_text_fr || null,
        instruction: null,
        onset: p.publication_datetime || null,
        expires: p.expiration_datetime || null,
        areaDesc: p.feature_name_en || p.feature_name_fr || p.province || "",
        source: "eccc",
        sourceUrl: "https://weather.gc.ca/warnings/index_e.html",
        geometryType: "polygon",
      },
    });
  }

  return features;
}

// DWD GeoServer WFS
async function fetchDWD(log: IntegrationContext["log"]): Promise<NormalizedFeature[]> {
  const res = await fetchWithTimeout(DWD_URL);
  if (!res.ok) {
    log.warn(`DWD WFS returned ${res.status}`);
    return [];
  }

  const data = await res.json();
  const features: NormalizedFeature[] = [];

  for (const f of data.features ?? []) {
    if (!f.geometry) continue;
    const p = f.properties;
    if (isExpired(p.EXPIRES)) continue;

    const headline = p.HEADLINE || p.EVENT || "Wetterwarnung";
    const id = p.IDENTIFIER || `${p.EC_GROUP}-${p.ONSET}-${headline}`.replace(/\s+/g, "-");

    features.push({
      type: "Feature",
      geometry: f.geometry,
      properties: {
        id: `dwd-${id}`,
        title: headline,
        severity: normalizeSeverity(p.SEVERITY),
        urgency: p.URGENCY || "Unknown",
        certainty: p.CERTAINTY || "Unknown",
        event: p.EVENT || p.EC_GROUP || "Unknown",
        description: p.DESCRIPTION || null,
        instruction: p.INSTRUCTION || null,
        onset: p.ONSET || null,
        expires: p.EXPIRES || null,
        areaDesc: p.NAME || "",
        source: "dwd",
        sourceUrl: "https://www.dwd.de/DE/wetter/warnungen_gemeinden/warnWetter_node.html",
        geometryType: "polygon",
      },
    });
  }

  return features;
}

// MeteoAlarm Atom+CAP feeds
async function fetchMeteoAlarm(log: IntegrationContext["log"]): Promise<NormalizedFeature[]> {
  const parser = new XMLParser({
    ignoreAttributes: false,
    removeNSPrefix: true,
    attributeNamePrefix: "@_",
    isArray: (name) => name === "entry",
  });

  const features: NormalizedFeature[] = [];

  // Batch feed fetches to avoid too many parallel connections
  for (let i = 0; i < METEOALARM_COUNTRIES.length; i += METEOALARM_BATCH_SIZE) {
    const batch = METEOALARM_COUNTRIES.slice(i, i + METEOALARM_BATCH_SIZE);
    const results = await Promise.allSettled(
      batch.map(async (cc) => {
        const url = `${METEOALARM_FEED_URL}${cc.toLowerCase()}`;
        const res = await fetchWithTimeout(url);
        if (!res.ok) return { cc, entries: [] };
        const xml = await res.text();
        const parsed = parser.parse(xml);
        const entries = parsed?.feed?.entry ?? [];
        return { cc, entries: Array.isArray(entries) ? entries : [entries] };
      }),
    );

    for (const result of results) {
      if (result.status !== "fulfilled") {
        log.warn("MeteoAlarm feed fetch failed", result.reason);
        continue;
      }
      const { cc, entries } = result.value;
      const centroid = COUNTRY_CENTROIDS[cc];
      if (!centroid) continue;

      for (let idx = 0; idx < entries.length; idx++) {
        const entry = entries[idx];
        if (!entry) continue;

        const severity = normalizeSeverity(
          entry.severity || entry["cap:severity"] || entry.Severity,
        );
        const expires = entry.expires || entry["cap:expires"] || entry.Expires || null;
        if (isExpired(expires)) continue;

        const event = entry.event || entry["cap:event"] || entry.Event || "Weather Alert";
        const title = entry.title?.toString() || `${event} — ${cc}`;
        const onset = entry.onset || entry["cap:onset"] || entry.Onset || null;
        const urgency = entry.urgency || entry["cap:urgency"] || entry.Urgency || "Unknown";
        const certainty = entry.certainty || entry["cap:certainty"] || entry.Certainty || "Unknown";

        features.push({
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: centroid,
          },
          properties: {
            id: `ma-${cc}-${idx}`,
            title,
            severity,
            urgency,
            certainty,
            event,
            description: null,
            instruction: null,
            onset,
            expires,
            areaDesc: entry.areaDesc || entry["cap:areaDesc"] || cc,
            source: "meteoalarm",
            sourceUrl: `https://www.meteoalarm.org/en/live/${cc.toLowerCase()}/`,
            geometryType: "point",
          },
        });
      }
    }
  }

  return features;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/events", async (_req, reply) => {
    const cacheKey = "weather-alerts:events";

    try {
      const cached = await ctx.cache.get<FeatureCollection>(cacheKey);
      if (cached) {
        reply.send(cached);
        return;
      }

      const [noaaResult, ecccResult, dwdResult, meteoAlarmResult] = await Promise.allSettled([
        fetchNOAA(ctx.log),
        fetchECCC(ctx.log),
        fetchDWD(ctx.log),
        fetchMeteoAlarm(ctx.log),
      ]);

      const noaaFeatures = noaaResult.status === "fulfilled" ? noaaResult.value : [];
      const ecccFeatures = ecccResult.status === "fulfilled" ? ecccResult.value : [];
      const dwdFeatures = dwdResult.status === "fulfilled" ? dwdResult.value : [];
      const meteoAlarmFeatures =
        meteoAlarmResult.status === "fulfilled" ? meteoAlarmResult.value : [];

      if (noaaResult.status === "rejected") {
        ctx.log.error("NOAA fetch failed", noaaResult.reason);
      }
      if (ecccResult.status === "rejected") {
        ctx.log.error("ECCC fetch failed", ecccResult.reason);
      }
      if (dwdResult.status === "rejected") {
        ctx.log.error("DWD fetch failed", dwdResult.reason);
      }
      if (meteoAlarmResult.status === "rejected") {
        ctx.log.error("MeteoAlarm fetch failed", meteoAlarmResult.reason);
      }

      const allFeatures = [...noaaFeatures, ...ecccFeatures, ...dwdFeatures, ...meteoAlarmFeatures];

      if (allFeatures.length === 0) {
        const stale = await ctx.cache.get<FeatureCollection>(cacheKey);
        if (stale) {
          reply.send(stale);
          return;
        }
        // No alerts is a valid state — return empty collection
        const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
        await ctx.cache.set(cacheKey, empty, CACHE_TTL);
        reply.send(empty);
        return;
      }

      const fc: FeatureCollection = {
        type: "FeatureCollection",
        features: allFeatures,
      };

      await ctx.cache.set(cacheKey, fc, CACHE_TTL);
      reply.send(fc);
    } catch (err) {
      ctx.log.error("Failed to fetch weather alert data", err);

      const stale = await ctx.cache.get<FeatureCollection>(cacheKey);
      if (stale) {
        reply.send(stale);
        return;
      }

      reply.status(503).send({ message: "Weather alert data temporarily unavailable" });
    }
  });
}
