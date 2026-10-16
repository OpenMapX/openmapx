import { bicycleOptions, type LngLat, type RoutingOptions } from "@openmapx/core";
import type { IntegrationContext, RoutingProvider } from "@openmapx/integration-framework";
import { mapBrouterRoute } from "./mapper.js";

/** Profile globals belong to the checksum-pinned 1.7.10 distribution. */
function brouterParameters(
  waypoints: LngLat[],
  options: RoutingOptions,
): Record<string, string | number> {
  const bike = bicycleOptions("cycling", options),
    kind = bike.bikeProfile;
  if (kind === "gravel" && options.avoidFerries)
    throw new Error("BRouter gravel profile cannot avoid ferries");
  if (kind === "gravel" && bike.bikeHillPreference === "strongly-avoid")
    throw new Error("BRouter gravel profile cannot strongly avoid hills");
  const profile =
    kind === "road"
      ? bike.bikePreferQuietRoads
        ? "fastbike-verylowtraffic"
        : "fastbike"
      : kind === "mountain"
        ? "mtb"
        : kind === "gravel"
          ? "gravel"
          : "trekking";
  const params: Record<string, string | number> = {
    lonlats: waypoints.map((p) => p.join(",")).join("|"),
    profile,
    format: "geojson",
    timode: 2,
  };
  if (options.avoidFerries) params["profile:allow_ferries"] = 0;
  if (bike.bikePreferQuietRoads) {
    if (kind === "gravel") params["profile:consider_traffic_estimate"] = 1;
    else if (kind === "mountain") params["profile:avoid_unsafe"] = 1;
    else if (kind !== "road") params["profile:consider_traffic"] = 1;
  }
  if (bike.bikeHillPreference !== "default") {
    const strong = bike.bikeHillPreference === "strongly-avoid";
    if (kind === "mountain") params["profile:hills"] = strong ? 2 : 1;
    else {
      params["profile:consider_elevation"] = 1;
      params["profile:uphillcost"] = strong ? 160 : 80;
      params["profile:uphillcutoff"] = strong ? 1 : 3;
      // Gravel assigns its costs in way context; use its exposed switches.
      if (kind === "gravel") {
        delete params["profile:uphillcost"];
        delete params["profile:uphillcutoff"];
        params["profile:consider_elevation"] = 1;
      }
    }
  }
  if (options.excludeLocations?.length)
    params.nogos = options.excludeLocations.map(([lng, lat]) => `${lng},${lat},30,-1`).join("|");
  if (options.excludePolygons?.length)
    params.polygons = options.excludePolygons
      .map((ring) => [...ring.flat(), -1].join(","))
      .join("|");
  return params;
}
export function createBrouterProvider(ctx: IntegrationContext, endpoint: string): RoutingProvider {
  const url = `${endpoint.replace(/\/+$/u, "")}/brouter`;
  return {
    id: "brouter",
    priority: 5,
    supportedModes: ["cycling"],
    supportsExclusions: true,
    async getRoute(waypoints, mode, options = {}) {
      if (mode !== "cycling" || options.departAt || options.arriveBy)
        throw new Error("BRouter supports untimed cycling routes only");
      const params = brouterParameters(waypoints, options);
      const acquire = async (alternativeidx: number) =>
        mapBrouterRoute(
          await ctx.http.get(url, {
            params: { ...params, alternativeidx },
            timeoutMs: 35000,
            maxResponseBytes: 32 * 1024 * 1024,
          }),
          waypoints,
          options,
        );
      const route = await acquire(0),
        routes = [route];
      if (options.alternatives !== false) {
        try {
          const alt = await acquire(1);
          if (JSON.stringify(alt.geometry) !== JSON.stringify(route.geometry)) routes.push(alt);
        } catch {
          /* A missing alternative must not discard a useful primary route. */
        }
      }
      return { waypoints, routes, activeRouteIndex: 0 };
    },
  };
}
