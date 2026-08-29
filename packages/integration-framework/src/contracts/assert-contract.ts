import type { RideCapability } from "@openmapx/core";
import type { RealtimeCapabilities } from "./realtime-provider.js";
import type { RideProvider } from "./ride-provider.js";
import type { TransitCapabilities } from "./transit-provider.js";

/**
 * Flat list of `[capabilityPath, requiredMethodName]` pairs for
 * `TransitProvider`. Each entry means: if `capabilities.<capabilityPath>` is
 * truthy, the provider object MUST expose `<requiredMethodName>` as a function.
 *
 * Derived directly from the `TransitCapabilities` / `TransitProvider`
 * interfaces in this package — do not add entries that don't correspond to
 * a real capability flag and interface method.
 */
const TRANSIT_CAPABILITY_METHODS: ReadonlyArray<
  [
    (
      | keyof TransitCapabilities
      | `stops.${string}`
      | `routes.${string}`
      | `alerts.${string}`
      | `reachability.${string}`
    ),
    string,
  ]
> = [
  ["stops.lookup", "getStop"],
  ["stops.nearby", "getStopsNearby"],
  ["stops.bbox", "getStopsInBbox"],
  ["stops.search", "searchStopsByName"],
  ["stops.infrastructure", "getStopInfrastructure"],
  ["stops.platforms", "getStopPlatforms"],
  ["stops.timetable", "getStopTimetable"],
  ["departures", "getDepartures"],
  ["arrivals", "getArrivals"],
  ["routes.lookup", "getRoute"],
  ["routes.forStop", "getRoutesForStop"],
  ["routes.stops", "getRouteStops"],
  ["routes.geometry", "getLegGeometry"],
  ["planning", "planTrip"],
  ["vehiclePositions", "getVehiclePositions"],
  ["vehicleJourney", "getVehicleJourney"],
  ["alerts.byStop", "getAlertsForStop"],
  ["alerts.byRoute", "getAlertsForRoute"],
  ["alerts.byBbox", "getAlertsForBbox"],
  ["facilities", "getFacilities"],
  ["reachability.estimatedSurface", "getReachabilitySurface"],
  ["reachability.exactPointChecks", "checkReachabilityDestinations"],
];

/**
 * Flat list of `[capabilityPath, requiredMethodName]` pairs for
 * `RealtimeProvider`. Same derivation rule as `TRANSIT_CAPABILITY_METHODS`.
 */
const REALTIME_CAPABILITY_METHODS: ReadonlyArray<
  [keyof RealtimeCapabilities | `alerts.${string}`, string]
> = [
  ["vehiclePositions", "getVehiclePositions"],
  ["alerts.byStop", "getAlertsForStop"],
  ["alerts.byRoute", "getAlertsForRoute"],
  ["alerts.byBbox", "getAlertsForBbox"],
  ["tripUpdates", "getTripUpdate"],
];

/** Resolve a dot-separated path (e.g. `"stops.lookup"`) into the value it
 *  names inside `capabilities`. Returns `undefined` for missing paths. */
function getCapabilityValue(
  capabilities: Record<string, unknown>,
  path: string,
): boolean | undefined {
  const parts = path.split(".");
  let node: unknown = capabilities;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "boolean" ? node : undefined;
}

/**
 * Assert that `provider` implements every method required by its declared
 * `capabilities`. Throws a single `Error` that lists all missing methods
 * when one or more capabilities are declared `true` but the corresponding
 * method is absent or not a function.
 *
 * Works for both `TransitProvider` and `RealtimeProvider` — pass the matching
 * `capabilityMethodPairs` table. Use the pre-built exports
 * `assertTransitProviderContract` and `assertRealtimeProviderContract` for the
 * standard cases.
 *
 * @param provider - The provider instance to inspect.
 * @param capabilities - The `capabilities` object declared on the provider.
 * @param capabilityMethodPairs - Table mapping capability dot-paths to the
 *   method name that must be present when the capability is `true`.
 * @param providerId - Optional label used in the error message.
 */
export function assertProviderSatisfiesContract(
  provider: Record<string, unknown>,
  capabilities: Record<string, unknown>,
  capabilityMethodPairs: ReadonlyArray<readonly [string, string]>,
  providerId?: string,
): void {
  const missing: string[] = [];

  for (const [capPath, methodName] of capabilityMethodPairs) {
    if (getCapabilityValue(capabilities, capPath) === true) {
      if (typeof provider[methodName] !== "function") {
        missing.push(`  capability "${capPath}" requires method "${methodName}"`);
      }
    }
  }

  if (missing.length > 0) {
    const label = providerId ? ` (provider: ${providerId})` : "";
    throw new Error(
      `Provider contract violation${label} — declared capabilities missing their required methods:\n${missing.join("\n")}`,
    );
  }
}

/**
 * Convenience wrapper for `TransitProvider` instances. Reads `provider.id`
 * for the error label automatically.
 */
export function assertTransitProviderContract(
  provider: { id: string; capabilities: TransitCapabilities } & Record<string, unknown>,
): void {
  assertProviderSatisfiesContract(
    provider,
    provider.capabilities as unknown as Record<string, unknown>,
    TRANSIT_CAPABILITY_METHODS,
    provider.id,
  );
}

/**
 * Convenience wrapper for `RealtimeProvider` instances.
 */
export function assertRealtimeProviderContract(
  provider: { id: string; capabilities: RealtimeCapabilities } & Record<string, unknown>,
): void {
  assertProviderSatisfiesContract(
    provider,
    provider.capabilities as unknown as Record<string, unknown>,
    REALTIME_CAPABILITY_METHODS,
    provider.id,
  );
}

/**
 * `[capability, requiredMethodName]` pairs for `RideProvider`. A provider that
 * advertises a capability must implement the method backing it, or the host
 * would dispatch to `undefined` at request time.
 */
const RIDE_CAPABILITY_METHODS: ReadonlyArray<[RideCapability, string]> = [
  ["quote", "getQuotes"],
  ["booking", "book"],
  ["tracking", "getBooking"],
];

export function assertRideProviderContract(provider: RideProvider): void {
  if (!provider.capabilities?.deepLink) {
    throw new Error(
      `Ride provider "${provider.id}" must declare the deepLink capability — handoff is the one required surface`,
    );
  }
  if (typeof provider.createHandoff !== "function") {
    throw new Error(`Ride provider "${provider.id}" declares deepLink but has no createHandoff()`);
  }
  for (const [capability, method] of RIDE_CAPABILITY_METHODS) {
    if (
      provider.capabilities[capability] &&
      typeof (provider as unknown as Record<string, unknown>)[method] !== "function"
    ) {
      throw new Error(
        `Ride provider "${provider.id}" declares the ${capability} capability but has no ${method}()`,
      );
    }
  }
}
