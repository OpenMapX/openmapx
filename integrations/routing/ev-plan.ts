import {
  bboxAroundPoint,
  type DataSourceAttribution,
  type DirectionsResult,
  type EvPlanWarning,
  type EvVehicleSpec,
  isSafeHttpUrl,
  matchesAnyOperator,
  normalizeOperator,
  type RoutingOptions,
} from "@openmapx/core";
import {
  ChargerSourcesUnavailableError,
  getVehiclePreset,
  planCharges,
  routeEnergyKwh,
} from "@openmapx/ev-charge-planner";
import {
  type ChargingSite,
  type ChargingSiteProvider,
  type ChargingSiteQuery,
  createSiteOrchestrator,
  type IntegrationContext,
  type SiteOrchestrator,
  toBBox,
} from "@openmapx/integration-framework";
import { availabilityOf } from "@openmapx/mobility-core/ev-charging";
import { applyClosureExclusions, resolveTravelInstant } from "./closure-exclusions.js";
import { roadConditionImpactForRequest } from "./road-condition-routing.js";
import { verifyRouteTraffic } from "./traffic-application.js";

/**
 * How close to the arrival reserve the trip may land before it counts as tight,
 * as a share of the pack. Absolute on purpose — see the re-validation below.
 */
const TIGHT_MARGIN_BAND_FRACTION = 0.05;

/** Upper bound on the sites one corridor window asks a provider for. */
const MAX_SITES_PER_WINDOW = 8000;

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
  preferredNetworks?: string[]; // operator display names
  avoidedNetworks?: string[];
  exclusiveNetworks?: boolean; // treat preferredNetworks as a hard whitelist
  preferCheaper?: boolean; // default true
  homePricePerKwh?: number; // home tariff for the trip-cost estimate
  homeCurrency?: string;
  units?: "metric" | "imperial";
  lang?: string;
}

interface EvRoutingProvider {
  supportsExclusions?: boolean;
  getRoute(
    waypoints: [number, number][],
    mode: "driving",
    options?: RoutingOptions,
  ): Promise<DirectionsResult>;
  getMatrix?(
    sources: [number, number][],
    targets: [number, number][],
    opts?: { mode?: "driving" },
  ): Promise<({ seconds: number; km: number } | null)[][]>;
}

/** A single `getRoutingProviders` resolution: provider + its owning integration id. */
export interface ResolvedRoutingProvider {
  integrationId: string;
  provider: EvRoutingProvider;
}

type ChargingSites = SiteOrchestrator<ChargingSiteProvider, ChargingSite, ChargingSiteQuery>;

const chargingSitesByContext = new WeakMap<IntegrationContext, ChargingSites>();

/**
 * Every `charging-sites` provider behind one search. The operator's
 * disallowed sources are pushed into each provider's query and filtered again
 * on each site's sources; a failing provider makes the answer partial. One
 * orchestrator serves every plan of an integration, so a failing provider is
 * logged once per outage rather than once per plan.
 */
function chargingSites(ctx: IntegrationContext): ChargingSites {
  let sites = chargingSitesByContext.get(ctx);
  if (!sites) {
    sites = createSiteOrchestrator<ChargingSiteProvider, ChargingSite, ChargingSiteQuery>(ctx, {
      domain: "charging-sites",
      logPrefix: "ev-plan",
      search: { name: "searchSites", run: (p, bbox, query) => p.searchSites(bbox, query) },
      get: { name: "getSite", run: (p, id, query) => p.getSite(id, query) },
    });
    chargingSitesByContext.set(ctx, sites);
  }
  return sites;
}

/**
 * A stop's credits as the charger place card shows them. Their links come
 * from upstream data, so only http(s) ones are kept.
 */
function stopCredits(site: ChargingSite): DataSourceAttribution[] {
  return site.attributions.map((a) => ({
    text: a.name,
    url: isSafeHttpUrl(a.url) ? a.url : "",
    ...(a.spdxLicense ? { license: a.spdxLicense } : {}),
    ...(isSafeHttpUrl(a.licenseUrl) ? { licenseUrl: a.licenseUrl } : {}),
  }));
}

/** An amount rounded to its currency's minor unit (cents, or none for yen). */
function roundToMinorUnit(amount: number, currency: string): number {
  let digits = 2;
  try {
    digits =
      new Intl.NumberFormat("en", { style: "currency", currency }).resolvedOptions()
        .maximumFractionDigits ?? 2;
  } catch {
    // An unknown currency code keeps two digits.
  }
  const scale = 10 ** digits;
  return Math.round(amount * scale) / scale;
}

/**
 * Orchestrate an EV charge-plan: base route → `planCharges` (with
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
  const closureAt = resolveTravelInstant(args.waypoints, args.departAt, undefined);
  const { exclusions, hasExclusions, exclusionsHash, roadConditionImpact } =
    await applyClosureExclusions(
      ctx,
      args.waypoints,
      Boolean(args.avoidClosures),
      closureAt,
      "driving",
    );
  const resolved = getRoutingProviders("driving", { requireTimeAware }).find(
    (entry) => !hasExclusions || entry.provider.supportsExclusions === true,
  );
  const routingProvider = resolved?.provider;
  if (!routingProvider) {
    throw Object.assign(
      new Error(
        hasExclusions ? "no routing provider supports closure exclusions" : "no routing provider",
      ),
      { status: 503 },
    );
  }
  // Built once and threaded into BOTH getRoute calls below by reference:
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
    useLiveTraffic: !closureAt,
    ...(hasExclusions && {
      excludeLocations: exclusions.points,
      excludePolygons: exclusions.polygons,
    }),
  };

  // Engine application proof belongs to the final route request, so plans
  // requiring road-condition assessment cannot reuse an earlier response.
  const responseRoadConditionImpact = roadConditionImpactForRequest(
    roadConditionImpact,
    !closureAt,
    [...(closureAt ? ["unsupported_future_shared_traffic"] : []), "ev_matrix_unprotected"],
  );
  const ttl = 0;
  const buildPlan = async () => {
    // getRoute returns a DirectionsResult; the planner needs the active Route.
    const baseDirections = await routingProvider.getRoute(args.waypoints, "driving", routingOpts);
    const baseRoute =
      baseDirections.routes[baseDirections.activeRouteIndex] ?? baseDirections.routes[0];
    if (!baseRoute) throw Object.assign(new Error("no base route"), { status: 502 });

    const sites = chargingSites(ctx);
    let partialChargerData = false;
    const nowMs = Date.now();

    const socStartKwh = (args.socStartPct / 100) * vehicle.batteryKwh;
    const socArrivalMinKwh = ((args.socArrivalMinPct ?? 10) / 100) * vehicle.batteryKwh;
    const socTargetKwh = ((args.socTargetPct ?? 80) / 100) * vehicle.batteryKwh;

    // Normalise the user's network preferences into match keys once.
    const preferredNetworkKeys = new Set(
      (args.preferredNetworks ?? []).map(normalizeOperator).filter(Boolean),
    );
    const avoidedNetworkKeys = new Set(
      (args.avoidedNetworks ?? []).map(normalizeOperator).filter(Boolean),
    );
    const exclusiveNetworkKeys = args.exclusiveNetworks ? preferredNetworkKeys : undefined; // hard whitelist
    const costWeight = args.preferCheaper === false ? 0 : 1;

    const plan = await planCharges(
      {
        route: baseRoute,
        vehicle,
        socStartKwh,
        socArrivalMinKwh,
        socTargetKwh,
        ambientTempC: args.ambientTempC ?? 20,
        hasElevation: (baseRoute.elevation?.length ?? 0) >= 2,
        nowMs,
        tripStartMs: closureAt?.getTime() ?? nowMs,
        preferredNetworkKeys,
        avoidedNetworkKeys,
        exclusiveNetworkKeys,
        costWeight,
      },
      {
        async requestCorridorChargers(centre, radiusKm) {
          const bbox = toBBox(bboxAroundPoint(centre, radiusKm * 1000));
          const answer = await sites.search(bbox, { maxSites: MAX_SITES_PER_WINDOW });
          if (answer.partial) partialChargerData = true;
          // An empty answer that is partial (a source failed, or answered for
          // part of the area only) is no evidence that the window has no chargers.
          if (answer.partial && answer.sites.length === 0) {
            throw new ChargerSourcesUnavailableError();
          }
          return answer.sites;
        },
        async requestMatrix(sources, targets) {
          if (typeof routingProvider.getMatrix === "function") {
            try {
              return await routingProvider.getMatrix(sources, targets, { mode: "driving" });
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
      const rerouted = await routingProvider.getRoute(wps, "driving", routingOpts);
      finalRoute = rerouted.routes[rerouted.activeRouteIndex] ?? rerouted.routes[0];
    }

    // Whole-trip re-validation: `planCharges` sizes charge amounts against the
    // BASE route, but the actual re-route through the chosen stops can cost
    // more energy than the base route did (detours to reach the chargers).
    // Re-check the final route's energy against the actual charged total and
    // flag it when the trip arrives within a thin band of the reserve. This is
    // whole-trip granularity — per-leg mid-trip re-validation is a future
    // refinement.
    const revalidationWarnings: EvPlanWarning[] = [];
    if (plan.stops.length > 0) {
      const finalEnergyKwh = routeEnergyKwh(finalRoute, vehicle, {
        ambientTempC: args.ambientTempC ?? 20,
        elevationAbsentDerate: (finalRoute.elevation?.length ?? 0) >= 2 ? 1 : 1.1,
      }).totalKwh;
      const totalChargedKwh = plan.stops.reduce((a, s) => a + s.addedKwh, 0);
      const arrivalKwh = socStartKwh + totalChargedKwh - finalEnergyKwh;
      // Thin band above the reserve; also covers arrival BELOW the reserve (the
      // final detour route can cost more energy than the base route the planner
      // sized the charge on). Deliberately a fixed slice of the pack rather than
      // a fraction of the reserve: scaling with the reserve meant a cautious 40%
      // reserve only counted as comfortable above 60% arrival, so raising the
      // reserve — which plans MORE charging — made the safer route warn while
      // the riskier one stayed silent.
      const tightBandKwh = vehicle.batteryKwh * TIGHT_MARGIN_BAND_FRACTION;
      if (arrivalKwh < socArrivalMinKwh + tightBandKwh) {
        revalidationWarnings.push({ kind: "tight-margin", legIndex: plan.stops.length });
      }
    }

    const tripCost = estimateTripCost(plan, args.homePricePerKwh, args.homeCurrency);

    return {
      routes: [finalRoute],
      activeRouteIndex: 0,
      waypoints: args.waypoints,
      provider: resolved.integrationId,
      roadConditionImpact: await verifyRouteTraffic(
        ctx,
        [finalRoute],
        responseRoadConditionImpact,
        resolved.integrationId,
      ),
      stops: plan.stops.map((s) => ({
        station: { id: s.site.id, name: s.site.name, coordinates: s.site.coordinates },
        connector: s.connector,
        powerKw: s.powerKw,
        operator: s.site.operator?.name,
        isPreferredNetwork: matchesAnyOperator(
          normalizeOperator(s.site.operator?.name),
          preferredNetworkKeys,
        ),
        arriveSocPct: Math.round((s.arriveSocKwh / vehicle.batteryKwh) * 100),
        departSocPct: Math.round((s.departSocKwh / vehicle.batteryKwh) * 100),
        chargeSeconds: Math.round(s.chargeSeconds),
        addedKwh: Math.round(s.addedKwh * 10) / 10,
        availability: availabilityOf(s.site),
        tariffPrice: s.estimatedCost?.price,
        estimatedCost: s.estimatedCost && {
          amount: roundToMinorUnit(s.estimatedCost.amount, s.estimatedCost.currency),
          currency: s.estimatedCost.currency,
        },
        attributions: stopCredits(s.site),
      })),
      totals: {
        driveSeconds: Math.round(finalRoute.duration),
        chargeSeconds: Math.round(plan.totalChargeSeconds),
        energyKwh: Math.round(plan.totalEnergyKwh * 10) / 10,
        ...(tripCost ? { estimatedCost: tripCost } : {}),
      },
      warnings: [
        ...plan.warnings,
        ...revalidationWarnings,
        ...(partialChargerData ? [{ kind: "partial-charger-data" } as const] : []),
      ],
    };
  };
  return ttl > 0
    ? ctx.cache.withCache(evPlanCacheKey(args, vehicle, exclusionsHash), ttl, buildPlan)
    : buildPlan();
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
 * Whole-trip cost: known public sessions priced by their own tariff, and all
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
