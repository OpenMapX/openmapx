import {
  type Itinerary,
  type LegId,
  refreshItineraryPost,
  trip,
} from "@motis-project/motis-client";
import {
  type HttpClient,
  TransitTripResolutionUnsupportedError,
} from "@openmapx/integration-framework";
import type { MotisInstance } from "@openmapx/mobility-core/motis-client";
import type { TransitTripResolveRequest, TripPlan } from "@openmapx/mobility-core/transit";
import { mapItinerary, rawId } from "./adapter.js";

const support = new WeakMap<MotisInstance["client"], { at: number; supported: boolean }>();
const supportTtl = 5 * 60_000;
function knownSupport(instance: MotisInstance) {
  const record = support.get(instance.client);
  return record && Date.now() - record.at < supportTtl ? record.supported : undefined;
}
/** Hosted support is advertised only after the endpoint actually answered. */
export function supportsStructuredTripResolution(instance: MotisInstance): boolean {
  return knownSupport(instance) === true;
}
const sameTime = (value: string | undefined, expected: string) =>
  value !== undefined &&
  Number.isFinite(Date.parse(value)) &&
  Date.parse(value) === Date.parse(expected);
const validPoint = (p: { lat: number; lon: number }) =>
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lon) &&
  Math.abs(p.lat) <= 90 &&
  Math.abs(p.lon) <= 180;

/** Keep SDK serialization while applying the host's bounded HTTP transport. */
function hostFetch(http: HttpClient): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const options = {
      headers: Object.fromEntries(request.headers),
      signal: request.signal,
      maxBytes: 8 * 1024 * 1024,
      contentTypes: ["application/json"],
    };
    const result =
      request.method === "GET"
        ? await http.getResponse(request.url, options)
        : request.method === "POST"
          ? await http.postResponse(request.url, await request.json(), options)
          : undefined;
    if (!result) throw new Error("Unsupported MOTIS request method");
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json" },
    });
  };
}

/** Reconstruct exact provider references with the provider's normal itinerary mapping. */
export async function resolveMotisTrip(
  instance: MotisInstance,
  params: TransitTripResolveRequest,
  opts?: { datasetEpoch?: string; useRoutedTransfers?: boolean; http?: HttpClient },
): Promise<TripPlan | null> {
  const refs = params.reference.legs;
  if (
    !refs.length ||
    refs.length > 8 ||
    (opts?.datasetEpoch !== undefined && params.reference.datasetEpoch !== opts.datasetEpoch) ||
    refs.some((r) =>
      [r.tripId, r.fromStopId, r.toStopId].some((id) => !id.startsWith(instance.prefix)),
    )
  )
    return null;
  if (knownSupport(instance) === false)
    throw new TransitTripResolutionUnsupportedError("MOTIS exact trip reconstruction unsupported");

  const sdkOptions = {
    client: instance.client,
    ...(opts?.http ? { fetch: hostFetch(opts.http) } : {}),
  };
  const native: LegId[] = [];
  for (const ref of refs) {
    // The server obtains coordinates, display name and native flags itself. None
    // of those values are accepted from a shared-text/client reconstruction.
    const original = await trip({
      ...sdkOptions,
      query: { tripId: rawId(instance, ref.tripId) },
    });
    if (original.error) {
      if (original.response?.status === 404 || original.response?.status === 400) return null;
      throw new Error("MOTIS exact trip source unavailable");
    }
    if (!Array.isArray(original.data?.legs))
      throw new Error("MOTIS exact trip response unavailable");
    const matches: LegId[] = [];
    for (const leg of original.data.legs) {
      if (
        leg.tripId !== rawId(instance, ref.tripId) ||
        typeof leg.scheduled !== "boolean" ||
        !leg.displayName
      )
        continue;
      const stops = [leg.from, ...(leg.intermediateStops ?? []), leg.to];
      for (let a = 0; a < stops.length; a++) {
        const from = stops[a];
        if (
          from.stopId !== rawId(instance, ref.fromStopId) ||
          !sameTime(
            from.scheduledDeparture ?? (a === 0 ? leg.scheduledStartTime : undefined),
            ref.scheduledDeparture,
          )
        )
          continue;
        for (let b = a + 1; b < stops.length; b++) {
          const to = stops[b];
          if (
            to.stopId !== rawId(instance, ref.toStopId) ||
            !sameTime(
              to.scheduledArrival ?? (b === stops.length - 1 ? leg.scheduledEndTime : undefined),
              ref.scheduledArrival,
            ) ||
            !validPoint(from) ||
            !validPoint(to)
          )
            continue;
          matches.push({
            displayName: leg.displayName,
            tripId: leg.tripId,
            fromId: from.stopId,
            fromLat: from.lat,
            fromLon: from.lon,
            fromLevel: from.level,
            toId: to.stopId,
            toLat: to.lat,
            toLon: to.lon,
            toLevel: to.level,
            schedStart: Date.parse(ref.scheduledDeparture) / 1000,
            schedEnd: Date.parse(ref.scheduledArrival) / 1000,
            mode: leg.mode,
            scheduled: leg.scheduled,
          });
        }
      }
    }
    if (matches.length !== 1) return null;
    const leg = matches[0];
    const previous = native.at(-1);
    if (previous)
      native.push({
        displayName: "",
        tripId: "",
        mode: "WALK",
        scheduled: true,
        fromId: previous.toId,
        fromLat: previous.toLat,
        fromLon: previous.toLon,
        fromLevel: previous.toLevel,
        toId: leg.fromId,
        toLat: leg.fromLat,
        toLon: leg.fromLon,
        toLevel: leg.fromLevel,
        schedStart: previous.schedEnd,
        schedEnd: leg.schedStart,
      });
    native.push(leg);
  }
  // The generated POST type omits query parameters. Passing an options variable
  // preserves the supported query fields through the SDK; HTTP tests verify it.
  const request = {
    ...sdkOptions,
    body: { id: { legs: native } },
    query: {
      detailedLegs: true,
      detailedTransfers: true,
      requireDisplayNameMatch: true,
      joinInterlinedLegs: false,
      numLegAlternatives: 2,
      useRoutedTransfers: opts?.useRoutedTransfers ?? false,
      ...(params.wheelchairRequired ? { pedestrianProfile: "WHEELCHAIR" } : {}),
      ...(params.requireBikeTransport ? { requireBikeTransport: true } : {}),
      ...(params.modes?.length ? { transitModes: params.modes } : {}),
    },
  };
  const resolved = await refreshItineraryPost(request);
  if (resolved.error || !resolved.data) {
    if ([405, 501].includes(resolved.response?.status ?? 0)) {
      support.set(instance.client, { at: Date.now(), supported: false });
      throw new TransitTripResolutionUnsupportedError(
        "MOTIS exact trip reconstruction unsupported",
      );
    }
    // A 404 can concern this reference rather than the endpoint's existence.
    if (resolved.response?.status === 404) return null;
    throw new Error("MOTIS exact trip source unavailable");
  }
  const raw: Itinerary = resolved.data;
  if (!raw.id || !Array.isArray(raw.legs)) throw new Error("MOTIS exact trip response unavailable");
  support.set(instance.client, { at: Date.now(), supported: true });
  if (raw.legs.some((leg) => leg.mode === "WALK" && leg.cancelled === true)) return null;
  const transit = raw.legs.filter((leg) => leg.mode !== "WALK");
  // Native refresh uses fuzzy candidate scoring and can return dummy legs. Do
  // not let the normalizer turn either into a plausible-looking selected trip.
  if (
    transit.length !== refs.length ||
    transit.some((leg, i) => {
      const r = refs[i];
      return (
        leg.tripId !== rawId(instance, r.tripId) ||
        leg.from.stopId !== rawId(instance, r.fromStopId) ||
        leg.to.stopId !== rawId(instance, r.toStopId) ||
        !sameTime(leg.scheduledStartTime, r.scheduledDeparture) ||
        !sameTime(leg.scheduledEndTime, r.scheduledArrival)
      );
    })
  )
    return null;
  const itinerary = mapItinerary(instance, raw, opts?.datasetEpoch);
  if (
    itinerary.legs.some(
      (leg) =>
        (params.wheelchairRequired && leg.wheelchairAccessible === false) ||
        (params.requireBikeTransport && leg.route && leg.bikesAllowed === false),
    )
  )
    return null;
  itinerary.datasetEpoch = opts?.datasetEpoch;
  const first = itinerary.legs[0],
    last = itinerary.legs.at(-1);
  if (!first || !last) return null;
  return {
    from: first.from,
    to: last.to,
    itineraries: [itinerary],
    provider: instance.provider,
    instance: instance.provider,
    source: instance.provider === "ms" ? "transit-motis-local" : "transitous",
    datasetEpoch: opts?.datasetEpoch,
  };
}
