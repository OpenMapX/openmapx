import type {
  Departure,
  TransitStop,
  TripItinerary,
  TripLeg,
  TripPlan,
  VehicleJourney,
  VehicleJourneyStop,
} from "../types";

const BASE_URL = "https://api.irail.be";
const STATIONS_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface IrailStation {
  id: string;
  name: string;
  locationX: string; // longitude
  locationY: string; // latitude
}

let stationsCache: IrailStation[] | null = null;
let stationsCachedAt = 0;

async function getAllStations(): Promise<IrailStation[]> {
  if (stationsCache && Date.now() - stationsCachedAt < STATIONS_TTL_MS) {
    return stationsCache;
  }
  try {
    const res = await fetch(`${BASE_URL}/stations/?format=json&lang=en`);
    if (!res.ok) return stationsCache ?? [];
    const data = (await res.json()) as { station?: IrailStation[] };
    stationsCache = data.station ?? [];
    stationsCachedAt = Date.now();
    return stationsCache;
  } catch {
    return stationsCache ?? [];
  }
}

function stationToStop(s: IrailStation): TransitStop {
  return {
    id: `ir:${s.id}`,
    name: s.name,
    lat: Number.parseFloat(s.locationY),
    lng: Number.parseFloat(s.locationX),
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
    .filter((s) => {
      const sLat = Number.parseFloat(s.locationY);
      const sLng = Number.parseFloat(s.locationX);
      return (
        Math.abs(sLat - lat) <= radiusDeg &&
        Math.abs(sLng - lng) <= radiusDeg / Math.max(Math.cos((lat * Math.PI) / 180), 0.01)
      );
    })
    .map(stationToStop);
}

export async function getStopById(stopId: string): Promise<TransitStop | null> {
  const rawId = stopId.startsWith("ir:") ? stopId.slice(3) : stopId;
  const stations = await getAllStations();
  const found = stations.find((s) => s.id === rawId);
  return found ? stationToStop(found) : null;
}

export async function searchByName(query: string, limit = 10): Promise<TransitStop[]> {
  const stations = await getAllStations();
  const q = query.toLowerCase();
  return stations
    .filter((s) => s.name.toLowerCase().includes(q))
    .slice(0, limit)
    .map(stationToStop);
}

// biome-ignore lint/suspicious/noExplicitAny: iRail liveboard entry
function normalizeLiveboardEntry(d: any): Departure {
  const delaySeconds = Number.parseInt(d.delay ?? "0", 10);
  const scheduledAt = new Date(Number.parseInt(d.time, 10) * 1000).toISOString();
  const expectedAt =
    delaySeconds !== 0
      ? new Date(new Date(scheduledAt).getTime() + delaySeconds * 1000).toISOString()
      : undefined;
  return {
    tripId: d.vehicle ?? d.vehicleinfo?.name ?? "",
    route: {
      id: `ir:${d.vehicle ?? ""}`,
      shortName: d.vehicle?.split(".").pop() ?? "",
      longName: d.vehicleinfo?.shortname ?? d.vehicle ?? "",
      mode: "rail",
    },
    headsign: d.stationinfo?.name ?? d.station ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds: delaySeconds || undefined,
    platform: d.platforminfo?.name ?? d.platform ?? undefined,
    canceled: d.canceled === "1",
    occupancy: d.occupancy?.name as "low" | "medium" | "high" | undefined,
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
  try {
    const res = await fetch(`${BASE_URL}/liveboard/?${params}`);
    if (!res.ok) return [];
    const data = (await res.json()) as {
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      departures?: { departure?: any };
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      arrivals?: { arrival?: any };
    };
    const raw2 = arrdep === "departure" ? data.departures?.departure : data.arrivals?.arrival;
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const entries: any[] = Array.isArray(raw2) ? raw2 : raw2 ? [raw2] : [];
    const cutoffMs = Date.now() + minutes * 60 * 1000;
    return entries
      .filter((d) => Number.parseInt(d.time, 10) * 1000 <= cutoffMs)
      .map(normalizeLiveboardEntry);
  } catch {
    return [];
  }
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  return fetchLiveboard(stopId, minutes, "departure");
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  return fetchLiveboard(stopId, minutes, "arrival");
}

export async function getVehicleJourney(vehicleId: string): Promise<VehicleJourney | null> {
  const rawId = vehicleId.startsWith("ir:") ? vehicleId.slice(3) : vehicleId;
  try {
    const params = new URLSearchParams({
      id: rawId,
      format: "json",
      lang: "en",
    });
    const res = await fetch(`${BASE_URL}/vehicle/?${params}`);
    if (!res.ok) return null;

    const data = (await res.json()) as {
      vehicle: string;
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      stops?: { stop?: any };
      occupancy?: { name: string };
    };

    const rawStops = data.stops?.stop;
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const stopsArr: any[] = Array.isArray(rawStops) ? rawStops : rawStops ? [rawStops] : [];

    const stops: VehicleJourneyStop[] = stopsArr.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (s: any): VehicleJourneyStop => {
        const delaySeconds = Number.parseInt(s.delay ?? "0", 10);
        const scheduledDepTime = Number.parseInt(s.scheduledDepartureTime ?? "0", 10);
        const scheduledArrTime = Number.parseInt(s.scheduledArrivalTime ?? "0", 10);
        const scheduledDeparture =
          scheduledDepTime !== 0 ? new Date(scheduledDepTime * 1000).toISOString() : undefined;
        const scheduledArrival =
          scheduledArrTime !== 0 ? new Date(scheduledArrTime * 1000).toISOString() : undefined;
        const expectedDeparture =
          scheduledDeparture && delaySeconds !== 0
            ? new Date(scheduledDepTime * 1000 + delaySeconds * 1000).toISOString()
            : undefined;
        const expectedArrival =
          scheduledArrival && delaySeconds !== 0
            ? new Date(scheduledArrTime * 1000 + delaySeconds * 1000).toISOString()
            : undefined;
        return {
          stopId: `ir:${s.stationinfo?.id ?? s.station}`,
          name: s.stationinfo?.name ?? s.station,
          lat: Number.parseFloat(s.stationinfo?.locationY ?? "0"),
          lng: Number.parseFloat(s.stationinfo?.locationX ?? "0"),
          platform: s.platforminfo?.name ?? s.platform ?? undefined,
          scheduledDeparture,
          scheduledArrival,
          expectedDeparture,
          expectedArrival,
          delaySeconds: delaySeconds || undefined,
          canceled: s.canceled === "1",
          departed: s.left === "1",
        };
      },
    );

    return {
      id: `ir:${data.vehicle}`,
      name: data.vehicle,
      provider: "irail",
      occupancy: data.occupancy?.name as "low" | "medium" | "high" | undefined,
      stops,
    };
  } catch {
    return null;
  }
}

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
  try {
    // iRail only covers Belgium — at least one endpoint must be within Belgium
    const BE_BBOX = { west: 2.54, south: 49.49, east: 5.92, north: 51.51 };
    const inBelgium = (lat: number, lng: number) =>
      lat >= BE_BBOX.south && lat <= BE_BBOX.north && lng >= BE_BBOX.west && lng <= BE_BBOX.east;
    if (!inBelgium(fromLat, fromLng) && !inBelgium(toLat, toLng)) return null;

    const stations = await getAllStations();
    if (stations.length === 0) return null;

    // Max snap distance ~20 km — keep results relevant to the Belgian rail network
    const MAX_SNAP_DIST_DEG = 0.18; // ~20 km at European latitudes

    function nearestStation(lat: number, lng: number): IrailStation | null {
      let best: IrailStation | null = null;
      let bestDist = Number.POSITIVE_INFINITY;
      for (const s of stations) {
        const sLat = Number.parseFloat(s.locationY);
        const sLng = Number.parseFloat(s.locationX);
        const dist = (sLat - lat) ** 2 + (sLng - lng) ** 2;
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
    const [year, month, day] = date.split("-");
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
    const res = await fetch(`${BASE_URL}/connections/?${params}`);
    if (!res.ok) return null;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { connection?: any[] };
    if (!Array.isArray(data.connection)) return null;

    // Estimate straight-line distance in meters
    function walkMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
      const dLat = (lat2 - lat1) * 111_320;
      const dLng = (lng2 - lng1) * 111_320 * Math.cos(((lat1 + lat2) / 2) * (Math.PI / 180));
      return Math.sqrt(dLat * dLat + dLng * dLng);
    }

    const itineraries: TripItinerary[] = data.connection.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (conn: any): TripItinerary => {
        const duration = Number.parseInt(conn.duration, 10);
        const startTime = new Date(Number.parseInt(conn.departure.time, 10) * 1000).toISOString();
        const endTime = new Date(Number.parseInt(conn.arrival.time, 10) * 1000).toISOString();
        const transfers = Number.parseInt(conn.vias?.number ?? "0", 10);

        const rawVias = conn.vias?.via;
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        const vias: any[] = Array.isArray(rawVias) ? rawVias : rawVias ? [rawVias] : [];

        const legs: TripLeg[] = [];

        const stationDepLat = Number.parseFloat(
          conn.departure.stationinfo?.locationY ?? String(fromLat),
        );
        const stationDepLng = Number.parseFloat(
          conn.departure.stationinfo?.locationX ?? String(fromLng),
        );
        const stationArrLat = Number.parseFloat(
          conn.arrival.stationinfo?.locationY ?? String(toLat),
        );
        const stationArrLng = Number.parseFloat(
          conn.arrival.stationinfo?.locationX ?? String(toLng),
        );
        // Use user's coordinates when close to the station so the line connects to the map pin
        const depLat =
          walkMeters(fromLat, fromLng, stationDepLat, stationDepLng) <= 1000
            ? fromLat
            : stationDepLat;
        const depLng =
          walkMeters(fromLat, fromLng, stationDepLat, stationDepLng) <= 1000
            ? fromLng
            : stationDepLng;
        const arrLat =
          walkMeters(toLat, toLng, stationArrLat, stationArrLng) <= 1000 ? toLat : stationArrLat;
        const arrLng =
          walkMeters(toLat, toLng, stationArrLat, stationArrLng) <= 1000 ? toLng : stationArrLng;

        if (vias.length === 0) {
          legs.push({
            mode: "rail",
            startTime,
            endTime,
            from: {
              name: fromStation.name,
              lat: depLat,
              lng: depLng,
              stopId: `ir:${fromStation.id}`,
            },
            to: {
              name: toStation.name,
              lat: arrLat,
              lng: arrLng,
              stopId: `ir:${toStation.id}`,
            },
            route: {
              shortName:
                conn.departure.vehicleinfo?.shortname ??
                conn.departure.vehicle?.split(".").pop() ??
                "",
              longName: (conn.departure.direction?.name as string) ?? "",
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [depLng, depLat],
                [arrLng, arrLat],
              ],
            },
          });
        } else {
          // First leg: departure → first via
          const firstVia = vias[0];
          const firstViaLat = Number.parseFloat(firstVia.stationinfo?.locationY ?? "0");
          const firstViaLng = Number.parseFloat(firstVia.stationinfo?.locationX ?? "0");
          legs.push({
            mode: "rail",
            startTime,
            endTime: new Date(
              Number.parseInt(firstVia.arrival?.time ?? conn.departure.time, 10) * 1000,
            ).toISOString(),
            from: {
              name: fromStation.name,
              lat: depLat,
              lng: depLng,
              stopId: `ir:${fromStation.id}`,
            },
            to: {
              name: firstVia.station ?? "",
              lat: firstViaLat,
              lng: firstViaLng,
              stopId: `ir:${firstVia.stationinfo?.id ?? ""}`,
            },
            route: {
              shortName:
                conn.departure.vehicleinfo?.shortname ??
                conn.departure.vehicle?.split(".").pop() ??
                "",
              longName: (conn.departure.direction?.name as string) ?? "",
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [depLng, depLat],
                [firstViaLng, firstViaLat],
              ],
            },
          });

          // Middle legs: via[i] → via[i+1]
          for (let i = 0; i < vias.length - 1; i++) {
            const fromVia = vias[i];
            const toVia = vias[i + 1];
            const fromViaLat = Number.parseFloat(fromVia.stationinfo?.locationY ?? "0");
            const fromViaLng = Number.parseFloat(fromVia.stationinfo?.locationX ?? "0");
            const toViaLat = Number.parseFloat(toVia.stationinfo?.locationY ?? "0");
            const toViaLng = Number.parseFloat(toVia.stationinfo?.locationX ?? "0");
            legs.push({
              mode: "rail",
              startTime: new Date(
                Number.parseInt(fromVia.departure?.time ?? "0", 10) * 1000,
              ).toISOString(),
              endTime: new Date(
                Number.parseInt(toVia.arrival?.time ?? "0", 10) * 1000,
              ).toISOString(),
              from: {
                name: fromVia.station ?? "",
                lat: fromViaLat,
                lng: fromViaLng,
                stopId: `ir:${fromVia.stationinfo?.id ?? ""}`,
              },
              to: {
                name: toVia.station ?? "",
                lat: toViaLat,
                lng: toViaLng,
                stopId: `ir:${toVia.stationinfo?.id ?? ""}`,
              },
              route: {
                shortName:
                  fromVia.departure?.vehicleinfo?.shortname ??
                  fromVia.departure?.vehicle?.split(".").pop() ??
                  "",
                longName: (fromVia.departure?.direction?.name as string) ?? "",
              },
              geometry: {
                type: "LineString",
                coordinates: [
                  [fromViaLng, fromViaLat],
                  [toViaLng, toViaLat],
                ],
              },
            });
          }

          // Last leg: last via → arrival
          const lastVia = vias[vias.length - 1];
          const lastViaLat = Number.parseFloat(lastVia.stationinfo?.locationY ?? "0");
          const lastViaLng = Number.parseFloat(lastVia.stationinfo?.locationX ?? "0");
          legs.push({
            mode: "rail",
            startTime: new Date(
              Number.parseInt(lastVia.departure?.time ?? "0", 10) * 1000,
            ).toISOString(),
            endTime,
            from: {
              name: lastVia.station ?? "",
              lat: lastViaLat,
              lng: lastViaLng,
              stopId: `ir:${lastVia.stationinfo?.id ?? ""}`,
            },
            to: {
              name: toStation.name,
              lat: arrLat,
              lng: arrLng,
              stopId: `ir:${toStation.id}`,
            },
            route: {
              shortName:
                lastVia.departure?.vehicleinfo?.shortname ??
                lastVia.departure?.vehicle?.split(".").pop() ??
                "",
              longName: (lastVia.departure?.direction?.name as string) ?? "",
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [lastViaLng, lastViaLat],
                [arrLng, arrLat],
              ],
            },
          });
        }

        // Add walking legs from user origin to departure station / arrival station to destination
        const fromStationLat = Number.parseFloat(fromStation.locationY);
        const fromStationLng = Number.parseFloat(fromStation.locationX);
        const toStationLat = Number.parseFloat(toStation.locationY);
        const toStationLng = Number.parseFloat(toStation.locationX);

        const originMeters = walkMeters(fromLat, fromLng, fromStationLat, fromStationLng);
        const destMeters = walkMeters(toStationLat, toStationLng, toLat, toLng);

        if (originMeters > 100) {
          const walkMin = Math.ceil(originMeters / 80); // ~80m/min walking speed
          const walkStartMs = new Date(startTime).getTime() - walkMin * 60_000;
          legs.unshift({
            mode: "walking",
            startTime: new Date(walkStartMs).toISOString(),
            endTime: startTime,
            from: { name: "Start", lat: fromLat, lng: fromLng },
            to: {
              name: fromStation.name,
              lat: depLat,
              lng: depLng,
              stopId: `ir:${fromStation.id}`,
            },
            geometry: {
              type: "LineString",
              coordinates: [
                [fromLng, fromLat],
                [depLng, depLat],
              ],
            },
          });
        }

        if (destMeters > 100) {
          const walkMin = Math.ceil(destMeters / 80);
          const walkEndMs = new Date(endTime).getTime() + walkMin * 60_000;
          legs.push({
            mode: "walking",
            startTime: endTime,
            endTime: new Date(walkEndMs).toISOString(),
            from: {
              name: toStation.name,
              lat: arrLat,
              lng: arrLng,
              stopId: `ir:${toStation.id}`,
            },
            to: { name: "End", lat: toLat, lng: toLng },
            geometry: {
              type: "LineString",
              coordinates: [
                [arrLng, arrLat],
                [toLng, toLat],
              ],
            },
          });
        }

        const walkDistance = Math.round(
          (originMeters > 100 ? originMeters : 0) + (destMeters > 100 ? destMeters : 0),
        );

        return { duration, startTime, endTime, transfers, walkDistance, legs };
      },
    );

    return {
      from: { name: fromStation.name, lat: fromLat, lng: fromLng },
      to: { name: toStation.name, lat: toLat, lng: toLng },
      itineraries,
    };
  } catch {
    return null;
  }
}
