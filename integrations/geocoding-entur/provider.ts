import type { Place } from "@openmapx/core";
import {
  type EnturGeocoder,
  type EnturGeocoderSources,
  isEnturRequestError,
} from "@openmapx/entur-client";
import {
  type GeocodingProvider,
  type HealthCheckResult,
  ProviderCancelledError,
  ProviderTimeoutError,
} from "@openmapx/integration-framework";
import { createEnturProjections, featureCity } from "./projections.js";

/** One immutable integration generation; the SDK owns all asynchronous operation checks. */
export function createEnturGeocodingProvider(options: {
  geocoder: EnturGeocoder;
  sources: EnturGeocoderSources;
  signal: AbortSignal;
  country: string;
  multiModal: "parent" | "child" | "all";
}): {
  provider: GeocodingProvider;
  lookupPlaceById(id: string, lang?: string): Promise<Place | null>;
  healthCheck(): Promise<HealthCheckResult>;
} {
  const { geocoder, sources, signal: generation, country, multiModal } = options;
  const projection = createEnturProjections(sources);
  async function run<T>(
    call: (signal: AbortSignal) => Promise<T>,
    caller?: AbortSignal,
  ): Promise<T> {
    const signal = caller ? AbortSignal.any([generation, caller]) : generation;
    try {
      const result = await call(signal);
      signal.throwIfAborted();
      return result;
    } catch (error) {
      if (signal.aborted)
        throw signal.reason instanceof ProviderTimeoutError
          ? signal.reason
          : new ProviderCancelledError();
      if (isEnturRequestError(error) && error.kind === "timeout") throw new ProviderTimeoutError();
      if (isEnturRequestError(error) && error.kind === "abort") throw new ProviderCancelledError();
      throw error;
    }
  }
  const filters = { countries: country ? [country] : undefined, multimodal: multiModal };
  const lookupPlaceById = async (id: string, lang?: string): Promise<Place | null> =>
    run(async (signal) => {
      const data = await geocoder.place({ ids: [id], lang }, signal);
      const feature = data.features.find((feature) => feature.properties.id === id);
      return feature ? projection.place(feature, lang) : null;
    });
  const provider: GeocodingProvider = {
    async geocode(query, lang, proximity) {
      return run(async (signal) => {
        const data = await geocoder.autocomplete(
          {
            q: query,
            limit: 10,
            lang,
            ...filters,
            ...(proximity ? { lon: proximity[0], lat: proximity[1] } : {}),
          },
          signal,
        );
        return data.features.map(projection.search);
      });
    },
    async autocomplete(query, lang, bias, context) {
      return run(async (signal) => {
        const data = await geocoder.autocomplete(
          {
            q: query,
            limit: 6,
            lang,
            ...filters,
            ...(bias?.proximity ? { lon: bias.proximity[0], lat: bias.proximity[1] } : {}),
          },
          signal,
        );
        return data.features.map((feature) => projection.autocomplete(feature, lang));
      }, context?.signal);
    },
    async reverseGeocode(lat, lng, lang) {
      return run(async (signal) => {
        const data = await geocoder.reverse(
          { lat, lon: lng, limit: 1, layers: ["address", "street", "place"], lang, ...filters },
          signal,
        );
        const feature = data.features[0];
        return feature
          ? {
              address: feature.properties.names.display,
              city: featureCity(feature) ?? "",
              contributors: sources.contributorsFor(feature),
            }
          : null;
      });
    },
  };
  return {
    provider,
    lookupPlaceById,
    async healthCheck() {
      try {
        return (await lookupPlaceById("NSR:StopPlace:337"))
          ? { status: "up" }
          : { status: "down", error: "Entur geocoder probe returned no matching place" };
      } catch {
        return { status: "down", error: "Entur geocoder API probe failed" };
      }
    },
  };
}
