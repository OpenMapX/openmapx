import type { EnturClient } from "../client";
import { EnturRequestError, isEnturRequestError } from "../errors";
import { autocomplete, place, reverse } from "./generated/client";
import type { FeatureOutput, ResultOutput } from "./generated/models";
import { AutocompleteParams, Place, PlaceParams, ReverseParams } from "./generated/models";
export type EnturGeocoderAutocompleteParams = AutocompleteParams;
export type EnturGeocoderReverseParams = ReverseParams;
export type EnturGeocoderPlaceParams = PlaceParams;
export type EnturGeocoderResult = ResultOutput;
export type EnturGeocoderFeature = FeatureOutput;
export type EnturGeocoderSource = Place["source"];
export interface EnturGeocoderPolicy {
  allowedSources(signal: AbortSignal): Promise<readonly EnturGeocoderSource[]>;
  assertLookupAllowed(
    ids: readonly string[],
    allowed: readonly EnturGeocoderSource[],
    signal: AbortSignal,
  ): Promise<void>;
}
export interface EnturGeocoder {
  autocomplete(
    params: EnturGeocoderAutocompleteParams,
    signal: AbortSignal,
  ): Promise<EnturGeocoderResult>;
  reverse(params: EnturGeocoderReverseParams, signal: AbortSignal): Promise<EnturGeocoderResult>;
  place(params: EnturGeocoderPlaceParams, signal: AbortSignal): Promise<EnturGeocoderResult>;
}
/** Every async dependency belongs to the SDK deadline, even when it ignores cancellation. */
function bounded<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    operation.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        if (signal.aborted) reject(signal.reason);
        else resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}
const allSources = Object.freeze([...Place.shape.source.options]);
function validateAutocomplete(params: AutocompleteParams): void {
  AutocompleteParams.strict().parse(params);
  const focus = [params.lat, params.lon, params.radius, params.weight].some(
    (value) => value !== undefined,
  );
  if (focus && (params.lat === undefined || params.lon === undefined))
    throw new EnturRequestError("config");
  if (params.bbox !== undefined) {
    const [west, south, east, north] = params.bbox.split(",").map(Number);
    if (
      west === undefined ||
      south === undefined ||
      east === undefined ||
      north === undefined ||
      ![west, south, east, north].every(Number.isFinite) ||
      Math.abs(west) > 180 ||
      Math.abs(east) > 180 ||
      Math.abs(south) > 90 ||
      Math.abs(north) > 90 ||
      west >= east ||
      south >= north
    )
      throw new EnturRequestError("config");
  }
  const filters = [
    params.layers,
    params.stopPlaceTypes,
    params.sources,
    params.countries,
    params.counties,
    params.localities,
    params.fareZones,
    params.fareZoneAuthorities,
  ];
  if (
    !params.q?.trim() &&
    !params.bbox &&
    !filters.some((values) => values?.some((value) => value.trim().length > 0))
  )
    throw new EnturRequestError("config");
}
export function createEnturGeocoder(
  client: EnturClient,
  options: { timeoutMs?: number; policy?: EnturGeocoderPolicy } = {},
): EnturGeocoder {
  const timeoutMs = options.timeoutMs === undefined ? 8000 : options.timeoutMs;
  if (
    !client ||
    typeof client.getJson !== "function" ||
    typeof client.assertSourceAllowed !== "function" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > 8000
  )
    throw new EnturRequestError("config");
  const policy = options.policy;
  if (
    policy &&
    (typeof policy.allowedSources !== "function" ||
      typeof policy.assertLookupAllowed !== "function")
  )
    throw new EnturRequestError("config");
  const allowedSources = policy?.allowedSources.bind(policy);
  const assertLookupAllowed = policy?.assertLookupAllowed.bind(policy);
  const run = async (
    operation: "autocomplete" | "reverse" | "place",
    input: AutocompleteParams | ReverseParams | PlaceParams,
    callerSignal: AbortSignal,
  ): Promise<EnturGeocoderResult> => {
    if (!(callerSignal instanceof AbortSignal)) throw new EnturRequestError("config");
    const timeout = new AbortController();
    const signal = AbortSignal.any([callerSignal, timeout.signal]);
    const deadline = Date.now() + timeoutMs;
    const timer = setTimeout(() => timeout.abort(), timeoutMs);
    const checkDeadline = () => {
      if (Date.now() >= deadline) timeout.abort();
      signal.throwIfAborted();
    };
    try {
      checkDeadline();
      let params: typeof input;
      try {
        params = structuredClone(input);
        if (operation === "autocomplete") validateAutocomplete(params as AutocompleteParams);
        else if (operation === "reverse") ReverseParams.strict().parse(params);
        else {
          PlaceParams.strict().parse(params);
          const ids = (params as PlaceParams).ids;
          if (!ids.length || ids.some((id) => !id.trim() || id.includes(",")))
            throw new Error("ids");
        }
      } catch {
        throw new EnturRequestError("config");
      }
      const allowed = async (): Promise<readonly EnturGeocoderSource[]> => {
        checkDeadline();
        const sources = allowedSources
          ? await bounded(
              Promise.resolve().then(() => allowedSources(signal)),
              signal,
            )
          : allSources;
        if (!Array.isArray(sources) || sources.some((source) => !allSources.includes(source)))
          throw new EnturRequestError("policy");
        return Object.freeze([...new Set(sources)]);
      };
      const before = await allowed();
      let result: EnturGeocoderResult;
      if (operation === "place") {
        const lookup = params as PlaceParams;
        if (!before.length) throw new EnturRequestError("policy");
        if (assertLookupAllowed)
          await bounded(
            Promise.resolve().then(() =>
              assertLookupAllowed(Object.freeze([...lookup.ids]), before, signal),
            ),
            signal,
          );
        checkDeadline();
        result = await bounded(place(lookup, { client, signal }), signal);
      } else {
        const search = params as AutocompleteParams & ReverseParams;
        const sources = (search.sources ?? allSources).filter((source) => before.includes(source));
        if (!sources.length) throw new EnturRequestError("policy");
        // Preserve omission with unrestricted policy; add only effective supplier restrictions.
        if (search.sources !== undefined || before.length !== allSources.length)
          search.sources = sources;
        checkDeadline();
        result = await bounded(
          operation === "autocomplete"
            ? autocomplete(search, { client, signal })
            : reverse(search, { client, signal }),
          signal,
        );
      }
      const after = await allowed();
      if (
        !after.length ||
        result.features.some(
          (feature) =>
            !before.includes(feature.properties.source) ||
            !after.includes(feature.properties.source),
        )
      )
        throw new EnturRequestError("policy");
      if (operation === "place" && assertLookupAllowed)
        await bounded(
          Promise.resolve().then(() =>
            assertLookupAllowed(Object.freeze([...(params as PlaceParams).ids]), after, signal),
          ),
          signal,
        );
      // Supplier/lookup checks can await after the transport's own API guard.
      // Revalidate API authority at this publication boundary within our deadline.
      await bounded(client.assertSourceAllowed("geocoder", signal), signal);
      checkDeadline();
      return result;
    } catch (error) {
      if (callerSignal.aborted)
        throw new EnturRequestError("abort", undefined, { cause: callerSignal.reason });
      if (timeout.signal.aborted) throw new EnturRequestError("timeout");
      if (isEnturRequestError(error)) throw error;
      throw new EnturRequestError("unavailable");
    } finally {
      clearTimeout(timer);
    }
  };
  return Object.freeze({
    autocomplete: (params: AutocompleteParams, signal: AbortSignal) =>
      run("autocomplete", params, signal),
    reverse: (params: ReverseParams, signal: AbortSignal) => run("reverse", params, signal),
    place: (params: PlaceParams, signal: AbortSignal) => run("place", params, signal),
  });
}
