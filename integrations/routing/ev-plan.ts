import {
  bboxAroundPoint,
  type EvVehicleSpec,
  matchesAnyOperator,
  normalizeOperator,
} from "@openmapx/core";
import { getVehiclePreset, planCharges, routeEnergyKwh } from "@openmapx/ev-charge-planner";
import type { IntegrationContext } from "@openmapx/integration-framework";
import type { EvChargingStation } from "@openmapx/mobility-core/ev-charging";
import { applyClosureExclusions, resolveTravelInstant } from "./closure-exclusions.js";

export interface EvPlanArgs {
  waypoints: [number, number][];
  vehicleId?: string;
  vehicle?: EvVehicleSpec;
  socStartPct: number;
  socArrivalMinPct?: number;
  socTargetPct?: number;
  ambientTempC?: number;
  departAt?: string;
  avoidClosures?: boolean;
  avoidTolls?: boolean;
  avoidHighways?: boolean;
  avoidFerries?: boolean;
  preferredNetworks?: string[]; // D9 — operator display names
  avoidedNetworks?: string[];
  exclusiveNetworks?: boolean; // D9 — treat preferredNetworks as a hard whitelist
  preferCheaper?: boolean; // D10 — default true
  homePricePerKwh?: number; // D11 — home tariff for trip-cost estimate
  homeCurrency?: string; // D11
  units?: "metric" | "imperial";
  lang?: string;
}

/** A single `getRoutingProviders` resolution: the routing provider + its owning integration id. */
export interface ResolvedRoutingProvider {
  integrationId: string;
  // biome-ignore lint/suspicious/noExplicitAny: mirrors the routing orchestrator's ResolvedProvider without importing its RoutingProvider type here (getRoute/getMatrix are duck-typed against the real provider shape).
  provider: any;
}

/**
 * Find the ev-charging provider (duck-typed `searchStations`) in the
 * `data-source` domain. `LoadedIntegration` is `{ id, providers: Map<domain,
 * unknown[]> }` — the providers live in the Map, not on a `.provider` field.
 */
function findStationSource(ctx: IntegrationContext) {
  for (const loaded of ctx.getIntegrationsByDomain("data-source")) {
    // biome-ignore lint/suspicious/noExplicitAny: LoadedIntegration.providers is Map<string, unknown[]>; narrowed below via the searchStations duck-type check.
    const providers = ((loaded as any).providers?.get?.("data-source") ?? []) as any[];
    for (const provider of providers) {
      if (provider && typeof provider.searchStations === "function") return provider;
    }
  }
  return null;
}

/**
 * Orchestrate an EV charge-plan: base Valhalla route → `planCharges` (with
 * corridor-charger + matrix callbacks) → re-route through the chosen stops →
 * assemble the response the `POST /directions/ev` route sends back.
 */
export async function runEvPlan(
  ctx: IntegrationContext,
  getRoutingProviders: (
    mode: "driving",
    o: { requireTimeAware: boolean },
  ) => ResolvedRoutingProvider[],
  args: EvPlanArgs,
) {
  const vehicle = args.vehicle ?? (args.vehicleId ? getVehiclePreset(args.vehicleId) : null);
  if (!vehicle) throw Object.assign(new Error("unknown or missing vehicle"), { status: 400 });

  const requireTimeAware = Boolean(args.departAt);
  const chain = getRoutingProviders("driving", { requireTimeAware }).filter(
    (e) => e.provider.id === "valhalla" || e.integrationId === "valhalla",
  );
  const valhalla = chain[0]?.provider;
  if (!valhalla) throw Object.assign(new Error("no Valhalla provider"), { status: 503 });

  const closureAt = resolveTravelInstant(args.waypoints, args.departAt, undefined);
  const { exclusions, hasExclusions, exclusionsHash } = await applyClosureExclusions(
    ctx,
    args.waypoints,
    Boolean(args.avoidClosures),
    closureAt,
  );
  // Built once and threaded into BOTH getRoute calls below by reference (D7):
  // the base route and the re-route through the chosen stops must honour the
  // same avoid flags + closure exclusions, or the re-route could silently
  // detour back through a closed segment the base route avoided.
  const routingOpts = {
    avoidHighways: !!args.avoidHighways,
    avoidTolls: !!args.avoidTolls,
    avoidFerries: !!args.avoidFerries,
    units: args.units ?? "metric",
    lang: args.lang,
    departAt: args.departAt,
    ...(hasExclusions && {
      excludeLocations: exclusions.points,
      excludePolygons: exclusions.polygons,
    }),
  };

  // Cache the whole plan (spec §7): key on rounded waypoints + vehicle + bucketed
  // SoC + temp + departAt + avoid flags + prefs + closure exclusionsHash.
  // TTL is always SHORT: live availability (D8) can shift the plan and we can't
  // know pre-run whether it influenced this one, so EV plans are never cached long.
  const ttl = 300;
  return ctx.cache.withCache(evPlanCacheKey(args, vehicle, exclusionsHash), ttl, async () => {
    // getRoute returns a DirectionsResult; the planner needs the active Route.
    const baseDirections = await valhalla.getRoute(args.waypoints, "driving", routingOpts);
    const baseRoute =
      baseDirections.routes[baseDirections.activeRouteIndex] ?? baseDirections.routes[0];
    if (!baseRoute) throw Object.assign(new Error("no base route"), { status: 502 });

    const disallowed = ctx.getDisallowedSourceIds
      ? await ctx.getDisallowedSourceIds()
      : new Set<string>();
    const stationSource = findStationSource(ctx);

    const socStartKwh = (args.socStartPct / 100) * vehicle.batteryKwh;
    const socArrivalMinKwh = ((args.socArrivalMinPct ?? 10) / 100) * vehicle.batteryKwh;
    const socTargetKwh = ((args.socTargetPct ?? 80) / 100) * vehicle.batteryKwh;

    // D9: normalise the user's network preferences into match keys once.
    const preferredNetworkKeys = new Set(
      (args.preferredNetworks ?? []).map(normalizeOperator).filter(Boolean),
    );
    const avoidedNetworkKeys = new Set(
      (args.avoidedNetworks ?? []).map(normalizeOperator).filter(Boolean),
    );
    const exclusiveNetworkKeys = args.exclusiveNetworks ? preferredNetworkKeys : undefined; // D9 hard whitelist
    const costWeight = args.preferCheaper === false ? 0 : 1; // D10

    const plan = await planCharges(
      {
        route: baseRoute,
        vehicle,
        socStartKwh,
        socArrivalMinKwh,
        socTargetKwh,
        ambientTempC: args.ambientTempC ?? 20,
        hasElevation: (baseRoute.elevation?.length ?? 0) >= 2,
        nowMs: Date.now(),
        preferredNetworkKeys,
        avoidedNetworkKeys,
        exclusiveNetworkKeys,
        costWeight,
      },
      {
        async requestCorridorChargers(centre, radiusKm) {
          if (!stationSource) return [];
          // bboxAroundPoint(center: LngLat, radiusMetres): BoundingBox (object, not tuple)
          const bbox = bboxAroundPoint(centre, radiusKm * 1000);
          const stations: EvChargingStation[] = await stationSource.searchStations(bbox);
          return stations.filter((s) => !s.sources?.some((src) => disallowed.has(src)));
        },
        async requestMatrix(sources, targets) {
          if (typeof valhalla.getMatrix === "function") {
            try {
              return await valhalla.getMatrix(sources, targets, { mode: "driving" });
            } catch (e) {
              ctx.log.warn("[ev] matrix failed; using great-circle", e as Error);
            }
          }
          return greatCircleMatrix(sources, targets);
        },
      },
    );

    // Re-route with inserted stops (same closure/avoid opts), if any.
    //
    // This assumes a 2-endpoint trip (origin + destination): charge stops are
    // spliced in between `args.waypoints[0]` and the last waypoint, and any
    // intermediate waypoints in between are dropped. The web UI enforces this
    // by hiding the add-stop control while EV mode is active (see
    // DirectionsPanelContent/WaypointList's isEvMode gating), so args.waypoints
    // should always have length 2 here. Full via-interleaving — figuring out
    // where along the route each user-supplied via falls relative to the
    // chosen charge stops — needs per-stop along-route distance the planner
    // doesn't currently expose, and is a future enhancement, not this fix.
    let finalRoute = baseRoute;
    if (plan.stops.length > 0) {
      const wps: [number, number][] = [
        args.waypoints[0],
        ...plan.stops.map((s) => s.coordinates),
        args.waypoints[args.waypoints.length - 1],
      ];
      const rerouted = await valhalla.getRoute(wps, "driving", routingOpts);
      finalRoute = rerouted.routes[rerouted.activeRouteIndex] ?? rerouted.routes[0];
    }

    // Whole-trip re-validation: `planCharges` sizes charge amounts against the
    // BASE route, but the actual re-route through the chosen stops can cost
    // more energy than the base route did (detours to reach the chargers).
    // Re-check the final route's energy against the actual charged total and
    // flag it when the trip arrives within a thin band of the reserve. This is
    // whole-trip granularity — per-leg mid-trip re-validation is a future
    // refinement.
    const revalidationWarnings: typeof plan.warnings = [];
    if (plan.stops.length > 0) {
      const finalEnergyKwh = routeEnergyKwh(finalRoute, vehicle, {
        ambientTempC: args.ambientTempC ?? 20,
        elevationAbsentDerate: (finalRoute.elevation?.length ?? 0) >= 2 ? 1 : 1.1,
      }).totalKwh;
      const totalChargedKwh = plan.stops.reduce((a, s) => a + s.addedKwh, 0);
      const arrivalKwh = socStartKwh + totalChargedKwh - finalEnergyKwh;
      // Thin band above the reserve; also covers arrival BELOW the reserve (the
      // final detour route can cost more energy than the base route the planner
      // sized the charge on).
      const tightBandKwh = Math.max(socArrivalMinKwh * 0.5, vehicle.batteryKwh * 0.03);
      if (arrivalKwh < socArrivalMinKwh + tightBandKwh) {
        revalidationWarnings.push({ kind: "tight-margin", legIndex: plan.stops.length });
      }
    }

    const tripCost = estimateTripCost(plan, args.homePricePerKwh, args.homeCurrency); // D11

    return {
      routes: [finalRoute],
      activeRouteIndex: 0,
      waypoints: args.waypoints,
      provider: "valhalla",
      stops: plan.stops.map((s) => ({
        station: { id: s.station.id, name: s.station.name, coordinates: s.station.coordinates },
        connector: s.connector,
        powerKw: s.powerKw,
        operator: s.station.operator?.name,
        isPreferredNetwork: matchesAnyOperator(
          normalizeOperator(s.station.operator?.name),
          preferredNetworkKeys,
        ),
        arriveSocPct: Math.round((s.arriveSocKwh / vehicle.batteryKwh) * 100),
        departSocPct: Math.round((s.departSocKwh / vehicle.batteryKwh) * 100),
        chargeSeconds: Math.round(s.chargeSeconds),
        addedKwh: Math.round(s.addedKwh * 10) / 10,
        availability: s.station.availability,
        tariffSummary: summariseTariff(s.station),
        estimatedCost: s.estimatedCost,
        attributions: s.station.attributions ?? [],
      })),
      totals: {
        driveSeconds: Math.round(finalRoute.duration),
        chargeSeconds: Math.round(plan.totalChargeSeconds),
        energyKwh: Math.round(plan.totalEnergyKwh * 10) / 10,
        ...(tripCost ? { estimatedCost: tripCost } : {}),
      },
      warnings: [...plan.warnings, ...revalidationWarnings],
    };
  });
}

/** Deterministic cache key: rounded waypoints + vehicle + bucketed inputs. */
function evPlanCacheKey(
  args: EvPlanArgs,
  vehicle: EvVehicleSpec,
  exclusionsHash: string | null,
): string {
  const round = (n: number, d = 4) => Math.round(n * 10 ** d) / 10 ** d;
  const bucket5 = (n: number) => Math.round(n / 5) * 5;
  return JSON.stringify({
    k: "ev-directions",
    wps: args.waypoints.map(([lng, lat]) => [round(lng), round(lat)]),
    veh: vehicle, // the RESOLVED spec (matches runEvPlan's args.vehicle ?? preset precedence)
    units: args.units ?? "metric",
    lang: args.lang ?? "en",
    soc0: bucket5(args.socStartPct),
    socMin: args.socArrivalMinPct ?? 10,
    socT: args.socTargetPct ?? 80,
    temp: Math.round((args.ambientTempC ?? 20) / 5) * 5,
    departAt: args.departAt ?? null,
    avoid: [!!args.avoidTolls, !!args.avoidHighways, !!args.avoidFerries, !!args.avoidClosures],
    pref: (args.preferredNetworks ?? []).map(normalizeOperator).filter(Boolean).sort(),
    avoidNet: (args.avoidedNetworks ?? []).map(normalizeOperator).filter(Boolean).sort(),
    onlyNet: args.exclusiveNetworks === true,
    cheap: args.preferCheaper !== false,
    home: [args.homePricePerKwh ?? null, args.homeCurrency ?? null],
    excl: exclusionsHash,
  });
}

/**
 * D11 whole-trip cost: known public sessions priced by their own tariff, and all
 * other energy (home + any unpriced public kWh) valued at the home tariff.
 * Public sessions priced in a currency other than `homeCurrency` are NOT
 * FX-converted (we have no rates) — they're reported separately in
 * `otherCurrencies` instead of being dropped from the estimate. Null when no
 * home price is given.
 */
function estimateTripCost(
  plan: {
    stops: { addedKwh: number; estimatedCost?: { amount: number; currency: string } }[];
    totalEnergyKwh: number;
  },
  homePricePerKwh: number | undefined,
  homeCurrency: string | undefined,
): {
  amount: number;
  currency: string;
  homeKwh: number;
  publicKwh: number;
  otherCurrencies?: { currency: string; amount: number }[];
} | null {
  if (homePricePerKwh == null || !homeCurrency) return null;
  // The home/public split below only holds when every planned stop is priced:
  // whatever is left after subtracting public energy is then genuinely the
  // energy the trip started with. A stop without tariff data would instead be
  // billed at the home rate, which both understates the trip badly and claims
  // an impossible amount was charged at home. Many networks publish no tariffs,
  // so report no cost at all rather than an invented one.
  if (plan.stops.some((s) => !s.estimatedCost)) return null;
  let pricedKwh = 0;
  let homeCurrencyPublicCost = 0;
  const foreign = new Map<string, number>();
  for (const s of plan.stops) {
    if (!s.estimatedCost) continue;
    pricedKwh += s.addedKwh;
    if (s.estimatedCost.currency === homeCurrency) {
      homeCurrencyPublicCost += s.estimatedCost.amount;
    } else {
      foreign.set(
        s.estimatedCost.currency,
        (foreign.get(s.estimatedCost.currency) ?? 0) + s.estimatedCost.amount,
      );
    }
  }
  const otherKwh = Math.max(0, plan.totalEnergyKwh - pricedKwh); // home + unpriced public, at home price
  const amount = otherKwh * homePricePerKwh + homeCurrencyPublicCost;
  const otherCurrencies = [...foreign.entries()]
    .map(([currency, amt]) => ({ currency, amount: Math.round(amt * 100) / 100 }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
  return {
    amount: Math.round(amount * 100) / 100,
    currency: homeCurrency,
    homeKwh: Math.round(otherKwh * 10) / 10,
    publicKwh: Math.round(pricedKwh * 10) / 10,
    ...(otherCurrencies.length ? { otherCurrencies } : {}),
  };
}

/** Great-circle fallback matrix, used when the routing engine's `/sources_to_targets` is unavailable. */
function greatCircleMatrix(sources: [number, number][], targets: [number, number][]) {
  const R = 6371;
  const KMH = 80;
  const km = (a: [number, number], b: [number, number]) => {
    const dLat = ((b[1] - a[1]) * Math.PI) / 180;
    const dLon = ((b[0] - a[0]) * Math.PI) / 180;
    const la1 = (a[1] * Math.PI) / 180;
    const la2 = (b[1] * Math.PI) / 180;
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  };
  return sources.map((s) =>
    targets.map((t) => {
      const d = km(s, t);
      return { km: d, seconds: (d / KMH) * 3600 };
    }),
  );
}

function summariseTariff(station: EvChargingStation): string | undefined {
  const energy = station.tariffs?.[0]?.elements.find((e) => e.type === "energy");
  return energy ? `${energy.price} ${energy.currency}/kWh` : undefined;
}
