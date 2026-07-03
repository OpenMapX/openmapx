import { fetchJson } from "@openmapx/core";
import type { IntegrationContext, Logger } from "@openmapx/integration-framework";

const FETCH_TIMEOUT_MS = 15_000;
const STATION_CACHE_TTL = 600;

type SensorType = "temperature" | "humidity" | "pm25" | "pm10" | "pressure" | "uv" | "noise";

const SENSOR_TITLE_MAP: Record<SensorType, string[]> = {
  temperature: ["temperatur", "temperature", "lufttemperatur", "temp", "air temperature"],
  humidity: ["rel. luftfeuchte", "luftfeuchte", "humidity", "relative humidity"],
  pm25: ["pm2.5", "pm 2.5", "feinstaub pm2.5"],
  pm10: ["pm10", "pm 10", "feinstaub pm10"],
  pressure: ["luftdruck", "pressure", "air pressure", "barometric pressure"],
  uv: ["uv-intensität", "uv intensity", "uv"],
  noise: ["lautstärke", "noise", "loudness", "schallpegel"],
};

const VALID_SENSOR_TYPES = new Set(Object.keys(SENSOR_TITLE_MAP));

// Sensor.Community hardware type(s) for each SensorType.
// null means Sensor.Community has no equivalent for that type.
const SC_TYPE_MAP: Record<SensorType, string[] | null> = {
  temperature: ["BME280", "DHT22"],
  humidity: ["BME280", "DHT22"],
  pm25: ["SDS011"],
  pm10: ["SDS011"],
  pressure: ["BME280", "BMP280", "BMP180"],
  uv: null,
  noise: ["DNMS"],
};

// Maps Sensor.Community value_type to our SensorType (and display metadata).
// P1 = PM10, P2 = PM2.5, pressure is in Pa (we convert to hPa).
const SC_VALUE_TYPE_MAP: Record<
  string,
  { sensorType: SensorType; unit: string; title: string; scale?: number }
> = {
  temperature: { sensorType: "temperature", unit: "°C", title: "Temperature" },
  humidity: { sensorType: "humidity", unit: "%", title: "Humidity" },
  pressure: { sensorType: "pressure", unit: "hPa", title: "Pressure", scale: 0.01 },
  P1: { sensorType: "pm10", unit: "µg/m³", title: "PM10" },
  P2: { sensorType: "pm25", unit: "µg/m³", title: "PM2.5" },
  noise_LAeq: { sensorType: "noise", unit: "dB(A)", title: "Noise LAeq" },
};

// Distance threshold in degrees (~50m at mid-latitudes) for cross-provider deduplication
const DEDUP_THRESHOLD_DEG = 0.00045;

interface OpenSenseMapBox {
  _id: string;
  name: string;
  currentLocation: { coordinates: [number, number] };
  lastMeasurementAt?: string;
  exposure: string;
  model?: string;
  sensors: {
    title: string;
    unit: string;
    sensorType: string;
    lastMeasurement?: { value: string; createdAt: string } | string;
  }[];
}

interface SensorCommunityEntry {
  id: number;
  timestamp: string;
  location: {
    id: number;
    latitude: string;
    longitude: string;
    indoor: number;
    country: string;
    altitude: string;
    exact_location: number;
  };
  sensor: {
    id: number;
    pin: string;
    sensor_type: { id: number; name: string; manufacturer: string };
  };
  sensordatavalues: { value_type: string; value: string; id?: number }[];
}

interface SensorReading {
  title: string;
  value: number;
  unit: string;
}

interface Station {
  id: string;
  name: string;
  lat: number;
  lng: number;
  value: number;
  unit: string;
  sensorTitle: string;
  sensorType: string;
  lastUpdated: string;
  exposure: string;
  model: string;
  allSensors: SensorReading[];
}

function roundBbox(south: number, west: number, north: number, east: number): string {
  const r = (n: number) => (Math.round(n * 10) / 10).toFixed(1);
  return `${r(south)},${r(west)},${r(north)},${r(east)}`;
}

export function setup(ctx: IntegrationContext): void {
  ctx.registerRoute("GET", "/stations", async (req, reply) => {
    const { south, west, north, east, sensor, exposure } = req.query as Record<string, string>;

    const s = Number.parseFloat(south);
    const w = Number.parseFloat(west);
    const n = Number.parseFloat(north);
    const e = Number.parseFloat(east);

    if ([s, w, n, e].some(Number.isNaN)) {
      reply.status(400).send({ message: "Invalid bbox coordinates" });
      return;
    }

    const sensorType = (sensor ?? "temperature") as SensorType;
    if (!VALID_SENSOR_TYPES.has(sensorType)) {
      reply.status(400).send({ message: "Invalid sensor type" });
      return;
    }

    const cacheKey = `env:${sensorType}:${exposure ?? "outdoor"}:${roundBbox(s, w, n, e)}`;
    const cached = await ctx.cache.get<Station[]>(cacheKey);
    if (cached) {
      reply.send(cached);
      return;
    }

    try {
      const log = ctx.log;
      const osmStations = await fetchOpenSenseMap(s, w, n, e, sensorType, exposure, log);
      const scStations = await fetchSensorCommunity(s, w, n, e, sensorType, exposure, log);

      const stations = deduplicateStations(osmStations, scStations);

      await ctx.cache.set(cacheKey, stations, STATION_CACHE_TTL);
      reply.send(stations);
    } catch (err) {
      ctx.log.error("[overlay-environment] Error fetching stations:", err);
      reply.status(502).send({ message: "Sensor data sources unavailable" });
    }
  });
}

async function fetchOpenSenseMap(
  s: number,
  w: number,
  n: number,
  e: number,
  sensorType: SensorType,
  exposure: string | undefined,
  log: Logger,
): Promise<Station[]> {
  try {
    const dateNow = new Date().toISOString();
    const url =
      `https://api.opensensemap.org/boxes?bbox=${w},${s},${e},${n}` +
      `&exposure=${exposure ?? "outdoor"}&format=json` +
      `&date=${dateNow}`;

    const boxes = await fetchJson<OpenSenseMapBox[]>(url, {
      timeoutMs: FETCH_TIMEOUT_MS,
      nullOnError: true,
    });
    if (!boxes) {
      log.warn("[overlay-environment] openSenseMap request failed");
      return [];
    }

    const sensorTitles = SENSOR_TITLE_MAP[sensorType];
    const stations: Station[] = [];

    for (const box of boxes) {
      if (!box.sensors?.length) continue;

      const allSensors: SensorReading[] = [];
      for (const sensor of box.sensors) {
        const m = sensor.lastMeasurement;
        if (!m || typeof m === "string") continue;
        const v = Number.parseFloat(m.value);
        if (Number.isNaN(v)) continue;
        allSensors.push({ title: sensor.title, value: v, unit: sensor.unit });
      }

      for (const sensor of box.sensors) {
        if (!sensorTitles.includes(sensor.title?.toLowerCase())) continue;
        const meas = sensor.lastMeasurement;
        if (!meas || typeof meas === "string") continue;

        const val = Number.parseFloat(meas.value);
        if (Number.isNaN(val)) continue;

        stations.push({
          id: box._id,
          name: box.name,
          lat: box.currentLocation.coordinates[1],
          lng: box.currentLocation.coordinates[0],
          value: val,
          unit: sensor.unit,
          sensorTitle: sensor.title,
          sensorType: sensor.sensorType,
          lastUpdated: meas.createdAt,
          exposure: box.exposure,
          model: box.model ?? "",
          allSensors,
        });
        break;
      }
    }

    return stations;
  } catch (err) {
    log.warn("[overlay-environment] openSenseMap fetch failed: %s", err);
    return [];
  }
}

async function fetchSensorCommunity(
  s: number,
  w: number,
  n: number,
  e: number,
  sensorType: SensorType,
  exposure: string | undefined,
  log: Logger,
): Promise<Station[]> {
  const hwTypes = SC_TYPE_MAP[sensorType];
  if (!hwTypes) return [];

  const stations: Station[] = [];
  const wantOutdoor = (exposure ?? "outdoor") === "outdoor";

  // Fetch each hardware type in parallel (usually 1-2 types per sensor)
  const fetches = hwTypes.map(async (hwType) => {
    try {
      // Sensor.Community bbox format: lat_sw,lon_sw,lat_ne,lon_ne
      const url =
        `https://data.sensor.community/airrohr/v1/filter/box=${s},${w},${n},${e}` +
        `&type=${hwType}`;

      const entries = await fetchJson<SensorCommunityEntry[]>(url, {
        timeoutMs: FETCH_TIMEOUT_MS,
        nullOnError: true,
      });
      if (!entries) {
        log.warn("[overlay-environment] Sensor.Community request failed for %s", hwType);
        return [];
      }
      return entries;
    } catch (err) {
      log.warn("[overlay-environment] Sensor.Community fetch failed for %s: %s", hwType, err);
      return [];
    }
  });

  const results = await Promise.all(fetches);

  // Group entries by location ID — multiple hardware sensors at the same
  // location produce separate entries; we merge them into one station.
  const byLocation = new Map<number, SensorCommunityEntry[]>();
  for (const entries of results) {
    for (const entry of entries) {
      if (wantOutdoor && entry.location.indoor === 1) continue;

      const existing = byLocation.get(entry.location.id);
      if (existing) {
        existing.push(entry);
      } else {
        byLocation.set(entry.location.id, [entry]);
      }
    }
  }

  for (const [locId, entries] of byLocation) {
    const loc = entries[0].location;
    const lat = Number.parseFloat(loc.latitude);
    const lng = Number.parseFloat(loc.longitude);
    if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

    // Collect all sensor readings from all entries at this location
    const allSensors: SensorReading[] = [];
    let primaryValue: number | undefined;
    let primaryUnit = "";
    let primaryTitle = "";
    let primaryHwType = "";
    let latestTimestamp = "";

    for (const entry of entries) {
      const ts = entry.timestamp;
      if (ts > latestTimestamp) latestTimestamp = ts;

      for (const sv of entry.sensordatavalues) {
        const mapping = SC_VALUE_TYPE_MAP[sv.value_type];
        if (!mapping) continue;

        let val = Number.parseFloat(sv.value);
        if (Number.isNaN(val)) continue;
        if (mapping.scale) val *= mapping.scale;
        val = Math.round(val * 100) / 100;

        allSensors.push({ title: mapping.title, value: val, unit: mapping.unit });

        // Pick the primary reading that matches the requested sensor type
        if (mapping.sensorType === sensorType && primaryValue === undefined) {
          primaryValue = val;
          primaryUnit = mapping.unit;
          primaryTitle = mapping.title;
          primaryHwType = entry.sensor.sensor_type.name;
        }
      }
    }

    if (primaryValue === undefined) continue;

    stations.push({
      id: `sc-${locId}`,
      name: `Sensor.Community #${entries[0].sensor.id}`,
      lat,
      lng,
      value: primaryValue,
      unit: primaryUnit,
      sensorTitle: primaryTitle,
      sensorType: primaryHwType,
      lastUpdated: latestTimestamp,
      exposure: loc.indoor === 0 ? "outdoor" : "indoor",
      model: `Sensor.Community ${primaryHwType}`,
      allSensors,
    });
  }

  return stations;
}

function deduplicateStations(osmStations: Station[], scStations: Station[]): Station[] {
  // openSenseMap stations take priority; remove Sensor.Community stations
  // that are within ~50m of an openSenseMap station (many SC stations
  // also report to openSenseMap, so this avoids cross-provider duplicates).
  const merged = [...osmStations];

  for (const sc of scStations) {
    const isDuplicate = osmStations.some(
      (osm) =>
        Math.abs(osm.lat - sc.lat) < DEDUP_THRESHOLD_DEG &&
        Math.abs(osm.lng - sc.lng) < DEDUP_THRESHOLD_DEG,
    );
    if (!isDuplicate) {
      merged.push(sc);
    }
  }

  return merged;
}
