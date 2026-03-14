/**
 * Road snapping — routes through a sequence of waypoints on the road network.
 * Reusable utility for any feature that needs to align points to actual roads.
 *
 * Uses Valhalla for bus routing (has a dedicated bus profile that handles
 * bus-only streets) and OSRM for driving/walking/cycling.
 */

const OSRM_URL = process.env.OSRM_URL ?? "https://router.project-osrm.org";
const VALHALLA_URL = process.env.VALHALLA_URL ?? "https://valhalla1.openstreetmap.de";
const TIMEOUT_MS = 10_000;
const MAX_WAYPOINTS_PER_REQUEST = 100;

interface MatchResult {
  type: "LineString";
  coordinates: [number, number][];
}

/**
 * Route through a sequence of [lng, lat] waypoints on the road network.
 * Returns a GeoJSON LineString following actual roads, or null on failure.
 *
 * @param coords Array of [lng, lat] coordinate pairs (min 2)
 * @param profile "bus" uses Valhalla; "driving" | "walking" | "cycling" uses OSRM
 */
export async function matchToRoads(
  coords: [number, number][],
  profile: "driving" | "walking" | "cycling" | "bus" = "driving",
): Promise<MatchResult | null> {
  if (coords.length < 2) return null;

  try {
    if (profile === "bus") {
      return await valhallaRoute(coords);
    }
    if (coords.length > MAX_WAYPOINTS_PER_REQUEST) {
      return osrmRouteInChunks(coords, profile);
    }
    return await osrmRoute(coords, profile);
  } catch {
    return null;
  }
}

// Valhalla (bus profile)

async function valhallaRoute(coords: [number, number][]): Promise<MatchResult | null> {
  const locations: { lon: number; lat: number; type: "break" | "through" }[] = coords.map((c) => ({
    lon: c[0],
    lat: c[1],
    type: "through",
  }));
  // First and last must be "break" to anchor the route
  locations[0].type = "break";
  locations[locations.length - 1].type = "break";

  const body = JSON.stringify({
    locations,
    costing: "bus",
    format: "osrm",
    shape_format: "geojson",
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${VALHALLA_URL}/route`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "User-Agent": "OpenMapX/1.0" },
      body,
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      code: string;
      routes?: { geometry: { type: "LineString"; coordinates: [number, number][] } }[];
    };
    if (data.code !== "Ok" || !data.routes?.length) return null;

    return { type: "LineString", coordinates: data.routes[0].geometry.coordinates };
  } finally {
    clearTimeout(timer);
  }
}

// OSRM (driving/walking/cycling)

async function osrmRoute(coords: [number, number][], profile: string): Promise<MatchResult | null> {
  const coordStr = coords.map((c) => `${c[0]},${c[1]}`).join(";");

  const url = new URL(`${OSRM_URL}/route/v1/${profile}/${coordStr}`);
  url.searchParams.set("geometries", "geojson");
  url.searchParams.set("overview", "full");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url.toString(), {
      headers: { "User-Agent": "OpenMapX/1.0" },
      signal: controller.signal,
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      code: string;
      routes?: { geometry: { type: "LineString"; coordinates: [number, number][] } }[];
    };
    if (data.code !== "Ok" || !data.routes?.length) return null;

    return { type: "LineString", coordinates: data.routes[0].geometry.coordinates };
  } finally {
    clearTimeout(timer);
  }
}

async function osrmRouteInChunks(
  coords: [number, number][],
  profile: string,
): Promise<MatchResult | null> {
  const allCoords: [number, number][] = [];
  for (let i = 0; i < coords.length; i += MAX_WAYPOINTS_PER_REQUEST - 1) {
    const chunk = coords.slice(i, i + MAX_WAYPOINTS_PER_REQUEST);
    if (chunk.length < 2) break;
    const result = await osrmRoute(chunk, profile);
    if (!result) return null;
    const startIdx = allCoords.length > 0 ? 1 : 0;
    allCoords.push(...result.coordinates.slice(startIdx));
  }
  return allCoords.length >= 2 ? { type: "LineString", coordinates: allCoords } : null;
}
