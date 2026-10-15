import type {
  PrecipitationType,
  RoadSurfaceSensor,
  RoadSurfaceState,
  RoadWeatherAir,
  RoadWeatherStation,
  RoadWeatherValue,
} from "@openmapx/integration-framework";
import {
  allowedReadings,
  type CreditSources,
  countryOf,
  credit,
  firstText,
  instantOf,
  itemIdOf,
  type LatestReading,
  list,
  NO_SOURCES,
  newestReading,
  noticeCredits,
  pointOf,
  type Rec,
  rec,
  sourcesOf,
  str,
  upstreamCredits,
} from "../features/record.js";

/**
 * How long a station's value stays current: the freshness window
 * OpenConditions gives every weather property. A station that stops
 * reporting keeps its last values in OpenConditions until they are swept.
 */
export const VALUE_FRESH_MS = 3_600_000;

const SURFACE_STATES: ReadonlySet<string> = new Set<RoadSurfaceState>([
  "dry",
  "damp",
  "wet",
  "frost",
  "ice",
  "black_ice",
  "snow",
  "packed_snow",
  "slush",
  "standing_water",
  "flooded",
  "chemically_wet",
  "unknown",
]);
const PRECIPITATION_TYPES: ReadonlySet<string> = new Set<PrecipitationType>([
  "none",
  "rain",
  "snow",
  "sleet",
  "hail",
  "drizzle",
  "freezing_rain",
]);

type AirNumber = Exclude<keyof RoadWeatherAir, "precipitation">;
type SurfaceNumber = Exclude<keyof RoadSurfaceSensor, "index" | "state">;

/** The air values a station's own (component-less) readings carry, by property. */
const AIR: Readonly<Record<string, AirNumber>> = {
  "weather.air_temperature": "temperatureC",
  "weather.dew_point": "dewPointC",
  "weather.humidity": "humidityPct",
  "weather.visibility": "visibilityM",
  "weather.wind_speed": "windSpeedMs",
  "weather.wind_gust": "windGustMs",
  "weather.wind_direction": "windDirectionDeg",
  "weather.precipitation_rate": "precipitationMmH",
};

/** The surface values a sensor channel's readings carry, by property. */
const SURFACE: Readonly<Record<string, SurfaceNumber>> = {
  "road.surface_temperature": "temperatureC",
  "road.subsurface_temperature": "subsurfaceTemperatureC",
  "road.freezing_point": "freezingPointC",
  "road.friction": "friction",
  "road.water_film": "waterFilmMm",
  "road.snow_depth": "snowDepthMm",
  "road.ice_thickness": "iceThicknessMm",
  "road.salt_concentration": "saltKgM3",
};

/** The units OpenConditions states each value in; a reading in another unit is left out. */
const UNITS: Readonly<Record<string, string>> = {
  "weather.air_temperature": "Cel",
  "weather.dew_point": "Cel",
  "weather.humidity": "%",
  "weather.visibility": "m",
  "weather.wind_speed": "m/s",
  "weather.wind_gust": "m/s",
  "weather.wind_direction": "deg",
  "weather.precipitation_rate": "mm/h",
  "road.surface_temperature": "Cel",
  "road.subsurface_temperature": "Cel",
  "road.freezing_point": "Cel",
  "road.friction": "1",
  "road.water_film": "mm",
  "road.snow_depth": "mm",
  "road.ice_thickness": "mm",
  "road.salt_concentration": "kg/m3",
};

const DEVICE_STATUS = "device.status";
const DEVICE_STATUSES: ReadonlySet<string> = new Set(["ok", "warning", "error", "offline"]);

/**
 * The station's `device.status` in effect: its operator's state of the
 * station's equipment. The state is dated by its last change, which may be
 * months ago, so its age says nothing; only its validity ends it.
 */
function deviceStatusOf(
  readings: readonly LatestReading[],
  now: number,
): { value: "ok" | "warning" | "error" | "offline"; since?: string } | undefined {
  const reading = newestReading(readings, DEVICE_STATUS, undefined);
  if (reading === undefined) return undefined;
  const until = reading.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);
  if (Number.isFinite(until) && until < now) return undefined;
  const value = categoryOf<"ok" | "warning" | "error" | "offline">(reading, DEVICE_STATUSES);
  if (!value) return undefined;
  const since = instantOf(reading.phenomenonTime);
  return { value, ...(since ? { since } : {}) };
}

function timeOf(reading: LatestReading): number {
  const at = instantOf(reading.phenomenonTime);
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

/**
 * Whether a reading is current at `now`: measured within its freshness
 * window, and not past the validity OpenConditions gives a change-only one.
 */
function current(reading: LatestReading, now: number): boolean {
  const until = reading.validUntil === undefined ? Number.NaN : Date.parse(reading.validUntil);
  if (Number.isFinite(until) && until < now) return false;
  return now - timeOf(reading) <= VALUE_FRESH_MS;
}

function measured<T>(reading: LatestReading, value: T): RoadWeatherValue<T> {
  const at = instantOf(reading.phenomenonTime);
  return { value, ...(at ? { observedAt: at } : {}) };
}

/** A quantity reading in its property's unit as a number; anything else (a sensor fault) is none. */
function quantityOf(reading: LatestReading): number | undefined {
  const result = rec(reading.result);
  const value = result.value;
  if (result.type !== "quantity" || typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }
  return result.unit === UNITS[reading.property] ? value : undefined;
}

function categoryOf<T extends string>(reading: LatestReading, set: ReadonlySet<string>) {
  const result = rec(reading.result);
  return result.type === "category" && typeof result.value === "string" && set.has(result.value)
    ? (result.value as T)
    : undefined;
}

/**
 * An OpenConditions `weather_station` record with its readings in effect as
 * a road weather station. The station's own readings are its air values;
 * each `sensor_channel` component's readings are a surface sensor's, grouped
 * by the channel's index. A value is shown only while it is current (see
 * `current`); a sensor fault, which OpenConditions states as an unknown
 * result, shows no value. The station is out of service when its collection
 * is removed for now or its `device.status` is `offline`; a `warning` or
 * `error` status is a suspected or confirmed fault, beside its values.
 * Null when the record is no placeable station or its survivor is excluded.
 */
export function recordToRoadWeatherStation(
  record: Rec,
  latest: readonly LatestReading[],
  excluded: (sourceId: string) => boolean = () => false,
  sources: CreditSources = NO_SOURCES,
  now: Date = new Date(),
): RoadWeatherStation | null {
  const id = itemIdOf(record);
  const location = rec(record.location);
  const coordinates = pointOf(location);
  if (!id || record.kind !== "weather_station" || !coordinates) return null;
  const all = sourcesOf(record);
  const survivor = all[0];
  if (survivor === undefined || excluded(survivor.id)) return null;
  const kept = all.filter((s) => !excluded(s.id));
  const allowed = allowedReadings(latest, excluded);
  // The device status is the station's own state, not a value it measures.
  const readings = allowed.filter((r) => r.property !== DEVICE_STATUS);
  const at = now.getTime();
  const device = deviceStatusOf(allowed, at);

  const channels = new Map<string, number>();
  for (const component of list(record.components)) {
    const key = str(component.key);
    if (component.kind !== "sensor_channel" || !key) continue;
    const index = rec(component.details).index;
    channels.set(key, typeof index === "number" && Number.isInteger(index) ? index : 1);
  }

  const air: RoadWeatherAir = {};
  const surface = new Map<number, RoadSurfaceSensor>();
  const pairs = new Set(readings.map((r) => `${r.property}\u0000${r.componentKey ?? ""}`));
  for (const pair of pairs) {
    const [property = "", key = ""] = pair.split("\u0000");
    const reading = newestReading(readings, property, key === "" ? undefined : key);
    if (reading === undefined || !current(reading, at)) continue;
    if (key === "") {
      if (property === "weather.precipitation_type") {
        const type = categoryOf<PrecipitationType>(reading, PRECIPITATION_TYPES);
        if (type) air.precipitation = measured(reading, type);
        continue;
      }
      const field = AIR[property];
      const value = quantityOf(reading);
      if (field && value !== undefined) air[field] = measured(reading, value);
      continue;
    }
    const index = channels.get(key);
    if (index === undefined) continue;
    const sensor = surface.get(index) ?? { index };
    if (property === "road.surface_state") {
      const state = categoryOf<RoadSurfaceState>(reading, SURFACE_STATES);
      if (state && (!sensor.state || sensor.state.value === "unknown")) {
        sensor.state = measured(reading, state);
      }
    } else {
      const field = SURFACE[property];
      const value = quantityOf(reading);
      if (field && value !== undefined && sensor[field] === undefined) {
        sensor[field] = measured(reading, value);
      }
    }
    if (Object.keys(sensor).length > 1) surface.set(index, sensor);
  }

  const newest = readings.reduce<LatestReading | undefined>(
    (found, r) => (found === undefined || timeOf(r) > timeOf(found) ? r : found),
    undefined,
  );
  const updatedAt = newest ? instantOf(newest.phenomenonTime) : undefined;
  const fresh = readings.some((r) => current(r, at));
  const name = firstText(record.name);
  const road = list(location.roads)
    .map((r) => str(r.ref) ?? firstText(r.name))
    .find(Boolean);
  const municipality = str(rec(location.admin).municipality);
  const country = countryOf(location);
  return {
    id,
    name: name ?? "",
    ...(country ? { country } : {}),
    coordinates,
    ...(road ? { road } : {}),
    ...(municipality ? { municipality } : {}),
    status:
      record.lifecycle === "temporarily_closed" || device?.value === "offline"
        ? "temporarily_closed"
        : "operational",
    ...(device?.value === "warning" || device?.value === "error"
      ? {
          fault: {
            level: device.value === "error" ? "confirmed" : "suspected",
            ...(device.since ? { since: device.since } : {}),
          },
        }
      : {}),
    air,
    surface: [...surface.values()].sort((a, b) => a.index - b.index),
    ...(updatedAt ? { updatedAt } : {}),
    stale: !fresh,
    sources: kept.map((s) => s.id),
    attributions: [
      ...kept.map((s) => credit(s, sources)),
      ...upstreamCredits(kept, sources),
      ...noticeCredits(kept, sources),
    ],
  };
}
