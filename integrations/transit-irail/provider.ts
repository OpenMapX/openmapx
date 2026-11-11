import { FetchJsonHttpError, fetchJson, isoWithOffsetInZone } from "@openmapx/core";
import {
  ProviderInputError,
  parseProviderPayload,
  parseProviderRecords,
} from "@openmapx/integration-framework";
import type {
  Departure,
  TransitStop,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
} from "@openmapx/mobility-core/transit";
import { z } from "zod";

const BASE_URL = "https://api.irail.be";
const STATIONS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const BELGIAN_TIME_ZONE = "Europe/Brussels";

/**
 * iRail reads `date` and `time` as Belgian local time. Render the planning
 * instant on the Brussels wall clock, including across daylight-saving changes.
 */
export function brusselsWallClock(instant: Date): { date: string; time: string } {
  if (!Number.isFinite(instant.getTime()))
    throw Object.assign(new Error("invalid planning time"), { code: "invalid_request" });
  const local = isoWithOffsetInZone(instant, BELGIAN_TIME_ZONE);
  return { date: local.slice(0, 10), time: local.slice(11, 19) };
}

/** iRail sends numbers as JSON strings in practice and as numbers in its docs. */
const numeric = z.union([
  z.number().finite(),
  z
    .string()
    .trim()
    .regex(/^-?\d+(\.\d+)?$/)
    .transform(Number),
]);
const latitude = numeric.pipe(z.number().min(-90).max(90));
const longitude = numeric.pipe(z.number().min(-180).max(180));
const flag = z.union([z.literal(0), z.literal(1), z.literal("0"), z.literal("1")]);
const optionalText = z.string().nullish();

const stationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  locationX: longitude,
  locationY: latitude,
});
const stationListSchema = z.object({ station: z.array(z.unknown()).min(1) });

interface IrailStation {
  id: string;
  name: string;
  lat: number;
  lng: number;
}

function toStation(s: z.infer<typeof stationSchema>): IrailStation {
  return { id: s.id, name: s.name, lat: s.locationY, lng: s.locationX };
}

/** One element or a list: iRail collapses single-entry lists in some responses. */
function oneOrMany<T extends z.ZodType>(item: T) {
  return z
    .union([z.array(item), item])
    .transform((value) => (Array.isArray(value) ? value : [value]));
}

const liveboardEntrySchema = z.object({
  time: numeric,
  delay: numeric.nullish(),
  vehicle: z.string().min(1),
  vehicleinfo: z.object({ shortname: optionalText, name: optionalText }).nullish(),
  station: optionalText,
  stationinfo: z.object({ name: optionalText }).nullish(),
  platform: z.union([z.string(), z.number()]).nullish(),
  platforminfo: z.object({ name: optionalText }).nullish(),
  canceled: flag.nullish(),
  occupancy: z.object({ name: optionalText }).nullish(),
});
type LiveboardEntry = z.infer<typeof liveboardEntrySchema>;

const departuresBoardSchema = z.object({
  departures: z.object({ departure: oneOrMany(z.unknown()).optional() }),
});
const arrivalsBoardSchema = z.object({
  arrivals: z.object({ arrival: oneOrMany(z.unknown()).optional() }),
});

const stationInfoSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  locationX: longitude,
  locationY: latitude,
});

const vehicleStopSchema = z.object({
  station: optionalText,
  stationinfo: stationInfoSchema,
  delay: numeric.nullish(),
  scheduledDepartureTime: numeric.nullish(),
  scheduledArrivalTime: numeric.nullish(),
  platform: z.union([z.string(), z.number()]).nullish(),
  platforminfo: z.object({ name: optionalText }).nullish(),
  canceled: flag.nullish(),
  left: flag.nullish(),
});

const vehicleSchema = z.object({
  vehicle: z.string().min(1),
  stops: z.object({ stop: oneOrMany(vehicleStopSchema) }),
  occupancy: z.object({ name: optionalText }).nullish(),
});

const connectionVehicleSchema = z.object({
  vehicle: optionalText,
  vehicleinfo: z.object({ shortname: optionalText }).nullish(),
  direction: z.object({ name: optionalText }).nullish(),
});
const coordinatesSchema = z.object({ locationX: longitude, locationY: latitude });
const connectionEndSchema = connectionVehicleSchema.extend({
  time: numeric,
  stationinfo: coordinatesSchema.nullish(),
});
const viaSchema = z.object({
  station: optionalText,
  stationinfo: coordinatesSchema.extend({ id: z.string().min(1), name: optionalText }),
  arrival: z.object({ time: numeric }),
  departure: connectionVehicleSchema.extend({ time: numeric }),
});
const connectionSchema = z.object({
  duration: numeric,
  departure: connectionEndSchema,
  arrival: connectionEndSchema,
  vias: z.object({ number: numeric.nullish(), via: oneOrMany(viaSchema).optional() }).nullish(),
});
type IrailConnection = z.infer<typeof connectionSchema>;

function flagSet(value: z.infer<typeof flag> | null | undefined): boolean {
  return value === 1 || value === "1";
}

function epochIso(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function isNotFound(error: unknown): boolean {
  return error instanceof FetchJsonHttpError && error.status === 404;
}

/** Fetch an iRail resource; failures throw so they never read as an empty answer. */
async function irailJson(url: string, what: string, signal?: AbortSignal): Promise<unknown> {
  try {
    return await fetchJson<unknown>(url, { signal });
  } catch (error) {
    if (signal?.aborted || isNotFound(error)) throw error;
    throw new Error(`iRail ${what} unavailable`, { cause: error });
  }
}

let stationsCache: IrailStation[] | null = null;
let stationsCachedAt = 0;

/**
 * The national station list, cached for a day. A failed or malformed refresh
 * serves the previous list when there is one and otherwise throws; a malformed
 * or empty list is never cached.
 */
async function getAllStations(signal?: AbortSignal): Promise<IrailStation[]> {
  if (stationsCache && Date.now() - stationsCachedAt < STATIONS_TTL_MS) {
    return stationsCache;
  }
  let stations: IrailStation[];
  try {
    const data = await irailJson(`${BASE_URL}/stations/?format=json&lang=en`, "stations", signal);
    const { station } = parseProviderPayload(stationListSchema, data, "iRail stations");
    stations = parseProviderRecords(stationSchema, station, "iRail stations").map(toStation);
  } catch (error) {
    if (stationsCache && !signal?.aborted) return stationsCache;
    throw error;
  }
  stationsCache = stations;
  stationsCachedAt = Date.now();
  return stationsCache;
}

function stationToStop(s: IrailStation): TransitStop {
  return {
    id: `ir:${s.id}`,
    name: s.name,
    lat: s.lat,
    lng: s.lng,
    modes: ["rail"],
    provider: "irail",
  };
}

export async function getStops(
  lat: number,
  lng: number,
  radiusMeters: number,
): Promise<TransitStop[]> {
  const stations = await getAllStations();
  const radiusDeg = radiusMeters / 111_320;

  return stations
    .filter(
      (s) =>
        Math.abs(s.lat - lat) <= radiusDeg &&
        Math.abs(s.lng - lng) <= radiusDeg / Math.max(Math.cos((lat * Math.PI) / 180), 0.01),
    )
    .map(stationToStop);
}

export async function getStopById(stopId: string): Promise<TransitStop | null> {
  const rawId = stopId.startsWith("ir:") ? stopId.slice(3) : stopId;
  const stations = await getAllStations();
  const found = stations.find((s) => s.id === rawId);
  return found ? stationToStop(found) : null;
}

export async function searchByName(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<TransitStop[]> {
  const stations = await getAllStations(signal);
  const q = query.toLowerCase();
  return stations
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map(stationToStop);
}

function normalizeLiveboardEntry(d: LiveboardEntry): Departure {
  const delaySeconds = d.delay ?? 0;
  const scheduledAt = epochIso(d.time);
  const expectedAt = delaySeconds !== 0 ? epochIso(d.time + delaySeconds) : undefined;
  const occupancy = d.occupancy?.name;
  return {
    tripId: d.vehicle,
    route: {
      id: `ir:${d.vehicle}`,
      shortName: d.vehicle.split(".").pop() ?? "",
      longName: d.vehicleinfo?.shortname ?? d.vehicle,
      mode: "rail",
    },
    headsign: d.stationinfo?.name ?? d.station ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds: delaySeconds || undefined,
    platform: d.platforminfo?.name ?? (d.platform != null ? String(d.platform) : undefined),
    canceled: flagSet(d.canceled),
    occupancy:
      occupancy === "low" || occupancy === "medium" || occupancy === "high" ? occupancy : undefined,
  };
}

async function fetchLiveboard(
  stopId: string,
  minutes: number,
  arrdep: "departure" | "arrival",
): Promise<Departure[]> {
  const raw = stopId.startsWith("ir:") ? stopId.slice(3) : stopId;
  const params = new URLSearchParams({
    id: raw,
    format: "json",
    lang: "en",
    arrdep,
  });
  // A failed or malformed board throws; it must not read as "no departures".
  let data: unknown;
  try {
    data = await irailJson(`${BASE_URL}/liveboard/?${params}`, "timetable");
  } catch (error) {
    // The station id came from the caller: iRail's 404 means it is unknown.
    if (isNotFound(error))
      throw new ProviderInputError("Unknown iRail station identifier", { cause: error });
    throw error;
  }
  const entries =
    arrdep === "departure"
      ? parseProviderPayload(departuresBoardSchema, data, "iRail timetable").departures.departure
      : parseProviderPayload(arrivalsBoardSchema, data, "iRail timetable").arrivals.arrival;
  const cutoffMs = Date.now() + minutes * 60 * 1000;
  return parseProviderRecords(liveboardEntrySchema, entries ?? [], "iRail timetable")
    .filter((d) => d.time * 1000 <= cutoffMs)
    .map(normalizeLiveboardEntry);
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  return fetchLiveboard(stopId, minutes, "departure");
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  return fetchLiveboard(stopId, minutes, "arrival");
}

export async function getVehicleJourney(vehicleId: string): Promise<VehicleJourney | null> {
  const rawId = vehicleId.startsWith("ir:") ? vehicleId.slice(3) : vehicleId;
  const params = new URLSearchParams({
    id: rawId,
    format: "json",
    lang: "en",
  });
  let data: unknown;
  try {
    data = await irailJson(`${BASE_URL}/vehicle/?${params}`, "vehicle");
  } catch (error) {
    if (isNotFound(error)) return null;
    throw error;
  }
  // A journey is one ordered stop sequence; a stop without coordinates breaks it.
  const vehicle = parseProviderPayload(vehicleSchema, data, "iRail vehicle");
  const stops = vehicle.stops.stop.map((s): VehicleJourneyStop => {
    const delaySeconds = s.delay ?? 0;
    const scheduledDep = s.scheduledDepartureTime ?? 0;
    const scheduledArr = s.scheduledArrivalTime ?? 0;
    return {
      stopId: `ir:${s.stationinfo.id}`,
      name: s.stationinfo.name,
      lat: s.stationinfo.locationY,
      lng: s.stationinfo.locationX,
      platform: s.platforminfo?.name ?? (s.platform != null ? String(s.platform) : undefined),
      scheduledDeparture: scheduledDep !== 0 ? epochIso(scheduledDep) : undefined,
      scheduledArrival: scheduledArr !== 0 ? epochIso(scheduledArr) : undefined,
      expectedDeparture:
        scheduledDep !== 0 && delaySeconds !== 0
          ? epochIso(scheduledDep + delaySeconds)
          : undefined,
      expectedArrival:
        scheduledArr !== 0 && delaySeconds !== 0
          ? epochIso(scheduledArr + delaySeconds)
          : undefined,
      delaySeconds: delaySeconds || undefined,
      canceled: flagSet(s.canceled),
      departed: flagSet(s.left),
    };
  });
  const occupancy = vehicle.occupancy?.name;
  return {
    id: `ir:${vehicle.vehicle}`,
    name: vehicle.vehicle,
    provider: "irail",
    occupancy:
      occupancy === "low" || occupancy === "medium" || occupancy === "high" ? occupancy : undefined,
    stops,
  };
}

// Estimate straight-line distance in meters
function walkMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const dLat = (lat2 - lat1) * 111_320;
  const dLng = (lng2 - lng1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
  return Math.sqrt(dLat * dLat + dLng * dLng);
}

function lineName(part: z.infer<typeof connectionVehicleSchema>): TripLeg["route"] {
  return {
    shortName: part.vehicleinfo?.shortname ?? part.vehicle?.split(".").pop() ?? "",
    longName: part.direction?.name ?? "",
  };
}

function railLeg(
  startTime: string,
  endTime: string,
  from: TripLeg["from"],
  to: TripLeg["to"],
  route: TripLeg["route"],
): TripLeg {
  return {
    mode: "rail",
    startTime,
    endTime,
    from,
    to,
    route,
    geometry: {
      type: "LineString",
      coordinates: [
        [from.lng, from.lat],
        [to.lng, to.lat],
      ],
    },
  };
}

function connectionToItinerary(
  conn: IrailConnection,
  fromStation: IrailStation,
  toStation: IrailStation,
  origin: { lat: number; lng: number },
  destination: { lat: number; lng: number },
): TripItinerary {
  const startTime = epochIso(conn.departure.time);
  const endTime = epochIso(conn.arrival.time);
  const vias = conn.vias?.via ?? [];
  const transfers = conn.vias?.number ?? vias.length;

  const depStation = conn.departure.stationinfo
    ? { lat: conn.departure.stationinfo.locationY, lng: conn.departure.stationinfo.locationX }
    : origin;
  const arrStation = conn.arrival.stationinfo
    ? { lat: conn.arrival.stationinfo.locationY, lng: conn.arrival.stationinfo.locationX }
    : destination;
  // Use the rider's coordinates when close to the station so the line connects to the map pin
  const dep =
    walkMeters(origin.lat, origin.lng, depStation.lat, depStation.lng) <= 1000
      ? origin
      : depStation;
  const arr =
    walkMeters(destination.lat, destination.lng, arrStation.lat, arrStation.lng) <= 1000
      ? destination
      : arrStation;
  const fromStop = { name: fromStation.name, ...dep, stopId: `ir:${fromStation.id}` };
  const toStop = { name: toStation.name, ...arr, stopId: `ir:${toStation.id}` };
  const viaStop = (via: (typeof vias)[number]) => ({
    name: via.station ?? via.stationinfo.name ?? "",
    lat: via.stationinfo.locationY,
    lng: via.stationinfo.locationX,
    stopId: `ir:${via.stationinfo.id}`,
  });

  const legs: TripLeg[] = [];
  const firstVia = vias[0];
  const lastVia = vias[vias.length - 1];
  if (!firstVia || !lastVia) {
    legs.push(railLeg(startTime, endTime, fromStop, toStop, lineName(conn.departure)));
  } else {
    legs.push(
      railLeg(
        startTime,
        epochIso(firstVia.arrival.time),
        fromStop,
        viaStop(firstVia),
        lineName(conn.departure),
      ),
    );
    for (let i = 0; i < vias.length - 1; i++) {
      const fromVia = vias[i] as (typeof vias)[number];
      const toVia = vias[i + 1] as (typeof vias)[number];
      legs.push(
        railLeg(
          epochIso(fromVia.departure.time),
          epochIso(toVia.arrival.time),
          viaStop(fromVia),
          viaStop(toVia),
          lineName(fromVia.departure),
        ),
      );
    }
    legs.push(
      railLeg(
        epochIso(lastVia.departure.time),
        endTime,
        viaStop(lastVia),
        toStop,
        lineName(lastVia.departure),
      ),
    );
  }

  // Add walking legs from the origin to the departure station and from the arrival station
  const originMeters = walkMeters(origin.lat, origin.lng, fromStation.lat, fromStation.lng);
  const destMeters = walkMeters(toStation.lat, toStation.lng, destination.lat, destination.lng);

  if (originMeters > 100) {
    const walkMin = Math.ceil(originMeters / 80); // ~80m/min walking speed
    const walkStartMs = Date.parse(startTime) - walkMin * 60_000;
    legs.unshift({
      mode: "walking",
      startTime: new Date(walkStartMs).toISOString(),
      endTime: startTime,
      from: { name: "Start", ...origin },
      to: fromStop,
      geometry: {
        type: "LineString",
        coordinates: [
          [origin.lng, origin.lat],
          [dep.lng, dep.lat],
        ],
      },
    });
  }

  if (destMeters > 100) {
    const walkMin = Math.ceil(destMeters / 80);
    const walkEndMs = Date.parse(endTime) + walkMin * 60_000;
    legs.push({
      mode: "walking",
      startTime: endTime,
      endTime: new Date(walkEndMs).toISOString(),
      from: toStop,
      to: { name: "End", ...destination },
      geometry: {
        type: "LineString",
        coordinates: [
          [arr.lng, arr.lat],
          [destination.lng, destination.lat],
        ],
      },
    });
  }

  const walkDistance = Math.round(
    (originMeters > 100 ? originMeters : 0) + (destMeters > 100 ? destMeters : 0),
  );
  return { duration: conn.duration, startTime, endTime, transfers, walkDistance, legs };
}

/**
 * Plan between the stations nearest to two points. Null means iRail cannot
 * serve the trip (outside Belgium, no nearby station, no connection); upstream
 * failures and malformed answers throw.
 */
export async function planConnections(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number,
  date: string,
  time: string,
  arriveBy?: boolean,
  numItineraries?: number,
): Promise<TripPlan | null> {
  // iRail only covers Belgium — at least one endpoint must be within Belgium
  const BE_BBOX = { west: 2.54, south: 49.49, east: 5.92, north: 51.51 };
  const inBelgium = (lat: number, lng: number) =>
    lat >= BE_BBOX.south && lat <= BE_BBOX.north && lng >= BE_BBOX.west && lng <= BE_BBOX.east;
  if (!inBelgium(fromLat, fromLng) && !inBelgium(toLat, toLng)) return null;

  const stations = await getAllStations();

  // Max snap distance ~20 km — keep results relevant to the Belgian rail network
  const MAX_SNAP_DIST_DEG = 0.18; // ~20 km at European latitudes

  function nearestStation(lat: number, lng: number): IrailStation | null {
    let best: IrailStation | null = null;
    let bestDist = Number.POSITIVE_INFINITY;
    for (const s of stations) {
      const dist = (s.lat - lat) ** 2 + (s.lng - lng) ** 2;
      if (dist < bestDist) {
        bestDist = dist;
        best = s;
      }
    }
    // Reject if the nearest station is too far away
    if (bestDist > MAX_SNAP_DIST_DEG ** 2) return null;
    return best;
  }

  const fromStation = nearestStation(fromLat, fromLng);
  const toStation = nearestStation(toLat, toLng);
  if (!fromStation || !toStation) return null;

  // Format date: YYYY-MM-DD → DDMMYY
  const [year = "", month = "", day = ""] = date.split("-");
  const dateFormatted = `${day}${month}${year.slice(2)}`;
  // Format time: HH:MM → HHMM
  const timeFormatted = time.slice(0, 5).replace(":", "");

  const params = new URLSearchParams({
    from: fromStation.id,
    to: toStation.id,
    date: dateFormatted,
    time: timeFormatted,
    timeSel: arriveBy ? "arrival" : "departure",
    format: "json",
    lang: "en",
    results: String(numItineraries ?? 3),
  });
  let data: unknown;
  try {
    data = await irailJson(`${BASE_URL}/connections/?${params}`, "connections");
  } catch (error) {
    // iRail answers 404 when it finds no connection between the stations.
    if (isNotFound(error)) return null;
    throw error;
  }
  const { connection } = parseProviderPayload(
    z.object({ connection: z.array(z.unknown()) }),
    data,
    "iRail connections",
  );
  const connections = parseProviderRecords(connectionSchema, connection, "iRail connections");
  if (connections.length === 0) return null;

  const origin = { lat: fromLat, lng: fromLng };
  const destination = { lat: toLat, lng: toLng };
  return {
    from: { name: fromStation.name, ...origin },
    to: { name: toStation.name, ...destination },
    itineraries: connections.map((conn) =>
      connectionToItinerary(conn, fromStation, toStation, origin, destination),
    ),
  };
}
