import type {
  Departure,
  TransitStop,
  TransportMode,
  TripItinerary,
  TripLeg,
  TripPlan,
} from "../types";

const BASE_URL = "https://transport.opendata.ch/v1";

function mapCategory(category: string): TransportMode {
  if (["IC", "ICE", "EC", "IR", "RE", "S", "R", "RB", "TGV", "NJ"].includes(category))
    return "rail";
  if (["B", "BN", "CAR"].includes(category)) return "bus";
  if (category === "T") return "tram";
  if (["BAT", "BT", "NF"].includes(category)) return "ferry";
  if (["FUN", "PB"].includes(category)) return "funicular";
  if (["SL", "GB"].includes(category)) return "cable_car";
  return "bus";
}

// biome-ignore lint/suspicious/noExplicitAny: opendata.ch station object
function normalizeStop(s: any): TransitStop {
  return {
    id: `ch:${s.id}`,
    name: s.name ?? "Unknown",
    // API uses x=lat, y=lng (counterintuitive but confirmed in spec)
    lat: s.coordinate.x,
    lng: s.coordinate.y,
    modes: ["rail"],
    provider: "opendata-ch",
  };
}

// biome-ignore lint/suspicious/noExplicitAny: opendata.ch station object
function isValidStation(s: any): boolean {
  return !!(s.id && s.coordinate?.x != null && s.coordinate?.y != null);
}

export async function getStops(lat: number, lng: number): Promise<TransitStop[]> {
  // Note: API uses x=lat, y=lng (counterintuitive but confirmed in spec)
  const params = new URLSearchParams({
    x: String(lat),
    y: String(lng),
    type: "station",
  });

  try {
    const res = await fetch(`${BASE_URL}/locations?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { stations?: any[] };
    return (data.stations ?? []).filter(isValidStation).map(normalizeStop);
  } catch {
    return [];
  }
}

export async function searchByName(query: string, limit = 10): Promise<TransitStop[]> {
  try {
    const params = new URLSearchParams({ query, type: "station" });
    const res = await fetch(`${BASE_URL}/locations?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { stations?: any[] };
    return (data.stations ?? []).filter(isValidStation).slice(0, limit).map(normalizeStop);
  } catch {
    return [];
  }
}

// biome-ignore lint/suspicious/noExplicitAny: opendata.ch stationboard entry
function normalizeStationboardEntry(entry: any, mode: "departure" | "arrival"): Departure {
  const isDep = mode === "departure";
  const scheduledAt = (isDep ? entry.stop.departure : entry.stop.arrival) as string;
  const delaySeconds = (entry.stop.delay ?? 0) * 60; // delay is in minutes
  const expectedAt =
    delaySeconds !== 0
      ? new Date(new Date(scheduledAt).getTime() + delaySeconds * 1000).toISOString()
      : undefined;
  // opendata.ch sets stop.prognosis.departure/arrival to null when cancelled
  const prognosis = entry.stop.prognosis;
  const canceled = prognosis != null && (isDep ? prognosis.departure : prognosis.arrival) === null;
  return {
    tripId: entry.number ?? entry.name ?? "",
    route: {
      id: `ch:${entry.number ?? ""}`,
      shortName: entry.number ?? entry.name ?? "",
      longName: entry.name ?? "",
      mode: mapCategory(entry.category ?? ""),
    },
    headsign: (isDep ? entry.to : entry.from) ?? "",
    scheduledAt,
    expectedAt,
    delaySeconds: delaySeconds || undefined,
    platform: entry.stop.platform ?? undefined,
    canceled,
  };
}

async function fetchStationboard(
  stopId: string,
  minutes: number,
  arrdep: "departure" | "arrival",
): Promise<Departure[]> {
  const raw = stopId.startsWith("ch:") ? stopId.slice(3) : stopId;
  // opendata.ch stationboard: max limit 40; scale with minutes
  const limit = String(Math.min(40, Math.max(10, minutes * 2)));
  const params = new URLSearchParams({ station: raw, limit, arrdep });
  try {
    const res = await fetch(`${BASE_URL}/stationboard?${params}`);
    if (!res.ok) return [];
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { stationboard?: any[] };
    const field = arrdep === "departure" ? "departure" : "arrival";
    const cutoff = new Date(Date.now() + minutes * 60 * 1000);
    return (
      (data.stationboard ?? [])
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        .filter((entry: any) => {
          const t = entry.stop?.[field];
          return t != null && new Date(t) <= cutoff;
        })
        // biome-ignore lint/suspicious/noExplicitAny: external API response
        .map((entry: any) => normalizeStationboardEntry(entry, arrdep))
    );
  } catch {
    return [];
  }
}

export async function getDepartures(stopId: string, minutes: number): Promise<Departure[]> {
  return fetchStationboard(stopId, minutes, "departure");
}

export async function getArrivals(stopId: string, minutes: number): Promise<Departure[]> {
  return fetchStationboard(stopId, minutes, "arrival");
}

interface ChStation {
  id: string;
  name: string;
  coordinate: { x: number; y: number };
}

async function findNearestStation(lat: number, lng: number): Promise<ChStation | null> {
  // API uses x=lat, y=lng (confirmed in spec)
  const params = new URLSearchParams({
    x: String(lat),
    y: String(lng),
    type: "station",
  });
  const res = await fetch(`${BASE_URL}/locations?${params}`);
  if (!res.ok) return null;
  // biome-ignore lint/suspicious/noExplicitAny: external API response
  const data = (await res.json()) as { stations?: any[] };
  const first = (data.stations ?? []).find(
    // biome-ignore lint/suspicious/noExplicitAny: external API response
    (s: any) => s.id && s.coordinate?.x != null && s.coordinate?.y != null,
  );
  if (!first) return null;
  return { id: first.id, name: first.name ?? "", coordinate: first.coordinate };
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
    const [fromStation, toStation] = await Promise.all([
      findNearestStation(fromLat, fromLng),
      findNearestStation(toLat, toLng),
    ]);
    if (!fromStation || !toStation) return null;

    const timeShort = time.slice(0, 5); // HH:MM
    const params = new URLSearchParams({
      from: fromStation.id,
      to: toStation.id,
      date,
      time: timeShort,
      limit: String(Math.min(numItineraries ?? 3, 6)), // opendata.ch max is not documented, 6 is safe
      ...(arriveBy ? { isArrivalTime: "1" } : {}),
    });

    const res = await fetch(`${BASE_URL}/connections?${params}`);
    if (!res.ok) return null;

    // biome-ignore lint/suspicious/noExplicitAny: external API response
    const data = (await res.json()) as { connections?: any[] };
    if (!Array.isArray(data.connections)) return null;

    const itineraries: TripItinerary[] = data.connections.map(
      // biome-ignore lint/suspicious/noExplicitAny: external API response
      (conn: any): TripItinerary => {
        // Duration string: "00d00:57:00" → split by ":"
        const durStr: string = conn.duration ?? "00d00:00:00";
        const parts = durStr.replace(/^\d+d/, "").split(":");
        const durationSeconds =
          Number.parseInt(parts[0] ?? "0", 10) * 3600 +
          Number.parseInt(parts[1] ?? "0", 10) * 60 +
          Number.parseInt(parts[2] ?? "0", 10);

        const legs: TripLeg[] = (conn.legs ?? []).map(
          // biome-ignore lint/suspicious/noExplicitAny: external API response
          (leg: any): TripLeg => {
            const isWalk = leg.journey == null && leg.walk;
            const mode: TransportMode = isWalk
              ? "walking"
              : mapCategory(leg.journey?.category ?? "");
            const fromLegLat = leg.from?.station?.coordinate?.x ?? 0;
            const fromLegLng = leg.from?.station?.coordinate?.y ?? 0;
            const toLegLat = leg.to?.station?.coordinate?.x ?? 0;
            const toLegLng = leg.to?.station?.coordinate?.y ?? 0;
            return {
              mode,
              startTime: leg.departure ?? "",
              endTime: leg.arrival ?? "",
              from: {
                name: leg.from?.station?.name ?? "",
                lat: fromLegLat,
                lng: fromLegLng,
                stopId: leg.from?.station?.id ? `ch:${leg.from.station.id}` : undefined,
              },
              to: {
                name: leg.to?.station?.name ?? "",
                lat: toLegLat,
                lng: toLegLng,
                stopId: leg.to?.station?.id ? `ch:${leg.to.station.id}` : undefined,
              },
              route: isWalk
                ? undefined
                : {
                    shortName: leg.journey?.name ?? "",
                    longName: leg.journey?.name ?? "",
                  },
              geometry: {
                type: "LineString",
                coordinates: [
                  [fromLegLng, fromLegLat],
                  [toLegLng, toLegLat],
                ],
              },
            };
          },
        );

        return {
          duration: durationSeconds,
          startTime: conn.from?.departure ?? "",
          endTime: conn.to?.arrival ?? "",
          transfers: conn.transfers ?? 0,
          walkDistance: 0,
          legs,
        };
      },
    );

    return {
      from: {
        name: fromStation.name,
        lat: fromStation.coordinate.x,
        lng: fromStation.coordinate.y,
      },
      to: {
        name: toStation.name,
        lat: toStation.coordinate.x,
        lng: toStation.coordinate.y,
      },
      itineraries,
    };
  } catch {
    return null;
  }
}
