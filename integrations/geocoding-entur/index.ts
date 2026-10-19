import {
  createEnturClient,
  createEnturGeocoder,
  createEnturGeocoderSources,
  ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS,
  enturGeocoderCoverage,
  normalizeEnturGeocoderCountry,
} from "@openmapx/entur-client";
import {
  createGeocoderSuggestionProvider,
  type IntegrationContext,
  resolveIntegrationContributors,
} from "@openmapx/integration-framework";
import { registerPlaceResolver } from "@openmapx/place-ids";
import { createEnturGeocodingProvider } from "./provider.js";

export function setup(ctx: IntegrationContext): void {
  const generation = new AbortController();
  const country = normalizeEnturGeocoderCountry(ctx.config.boundaryCountry);
  const multiModal = ctx.config.multiModal ?? "parent";
  if (multiModal !== "parent" && multiModal !== "child" && multiModal !== "all")
    throw new Error("Invalid Entur multimodal configuration");
  const contributors = Object.fromEntries(
    ["entur-geocoder", ...Object.values(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS)]
      .filter((sourceId) =>
        ctx.manifest.dataSources?.some((source) => source.sourceId === sourceId),
      )
      .map((sourceId) => [sourceId, resolveIntegrationContributors(ctx, [sourceId])]),
  );
  const isSourceAllowed = async (sourceId: string) => {
    const denied = await ctx.getDisallowedSourceIds?.();
    return !denied?.has(sourceId) && !denied?.has(ctx.id);
  };
  const sources = createEnturGeocoderSources({ contributors, isSourceAllowed });
  const client = createEnturClient({
    http: ctx.http,
    upstreamRuntime: ctx.upstreamRuntime,
    config: {
      geocoderEndpoint: ctx.config.endpoint as string | undefined,
      clientName: ctx.config.clientName as string | undefined,
    },
    sourceIds: { geocoder: "entur-geocoder" },
    contributors,
    isSourceAllowed,
  });
  const geocoder = createEnturGeocoder(client, { timeoutMs: 4000, policy: sources });
  const entur = createEnturGeocodingProvider({
    geocoder,
    sources,
    signal: generation.signal,
    country,
    multiModal,
  });
  ctx.onShutdown(async () => {
    generation.abort(new Error("Entur geocoding generation retired"));
  });
  ctx.registerGeocodingProvider(entur.provider);
  ctx.registerSearchSuggestionProvider(
    createGeocoderSuggestionProvider({
      id: ctx.id,
      geocoder: entur.provider,
      coverage: () => enturGeocoderCoverage(country),
      attributions: () => [],
    }),
  );
  ctx.registerHealthCheck(entur.healthCheck);
  registerPlaceResolver("entur", (value, resolverCtx) =>
    entur.lookupPlaceById(value, resolverCtx.lang),
  );
  registerPlaceResolver("nsr", (value, resolverCtx) =>
    entur.lookupPlaceById(`NSR:${value}`, resolverCtx.lang),
  );
}
