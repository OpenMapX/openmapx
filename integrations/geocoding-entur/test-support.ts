import {
  createEnturClient,
  createEnturGeocoder,
  createEnturGeocoderSources,
  ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS,
  type EnturGeocoderFeature,
} from "@openmapx/entur-client";
import type { FakeHttpResponder } from "@openmapx/integration-framework/testing";
import {
  createMockIntegrationContext,
  fakeHttpClient,
} from "@openmapx/integration-framework/testing";
import manifest from "./manifest.json";
import { createEnturGeocodingProvider } from "./provider.js";

export const STOP: EnturGeocoderFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [10.75, 59.911] },
  properties: {
    id: "NSR:StopPlace:337",
    names: { default: "Oslo S", display: "Oslo S, Oslo" },
    layer: "stopPlace",
    source: "nsr",
    address: { locality: "Oslo", county: "Oslo", countryCode: "no" },
    stopPlaceTypes: ["railStation", "busStation"],
    transportModes: [{ mode: "rail" }, { mode: "bus" }],
    description: { eng: "Main stop", nor: "Hovedstopp" },
  },
};
export const ADDRESS: EnturGeocoderFeature = {
  type: "Feature",
  geometry: { type: "Point", coordinates: [10.74, 59.92] },
  properties: {
    id: "KVE:PostalAddress:285717643",
    names: { default: "Karl Johans gate 1", display: "Karl Johans gate 1, Oslo" },
    layer: "address",
    source: "kartverket-matrikkelenadresse",
    address: {
      streetName: "Karl Johans gate",
      houseNumber: "1",
      postalCode: "0154",
      locality: "Oslo",
      countryCode: "no",
    },
  },
};
/** Native six-layer fixtures; non-station layers never acquire station types or modes. */
export const LAYERS: Record<EnturGeocoderFeature["properties"]["layer"], EnturGeocoderFeature> = {
  address: ADDRESS,
  street: {
    ...ADDRESS,
    properties: {
      id: "KVE:Street:0301-12600",
      names: { default: "Karl Johans gate", display: "Karl Johans gate, Oslo" },
      address: ADDRESS.properties.address,
      layer: "street",
      source: "kartverket-matrikkelenadresse",
    },
  },
  stopPlace: STOP,
  groupOfStopPlaces: {
    ...STOP,
    properties: {
      id: "NSR:GroupOfStopPlaces:1",
      names: { default: "Oslo", display: "Oslo" },
      address: STOP.properties.address,
      layer: "groupOfStopPlaces",
      source: "nsr",
    },
  },
  poi: {
    ...STOP,
    properties: {
      id: "OSM:TopographicPlace:7118275595",
      names: {
        default: "Espresso House Oslo S Hovedhallen",
        display: "Espresso House Oslo S Hovedhallen, Oslo",
      },
      address: STOP.properties.address,
      layer: "poi",
      source: "openstreetmap",
      categories: ["poi", "cafe"],
    },
  },
  place: {
    ...STOP,
    properties: {
      id: "KVE:PlaceName:123",
      names: { default: "Oslo", display: "Oslo" },
      address: STOP.properties.address,
      layer: "place",
      source: "kartverket-stedsnavn",
    },
  },
};
export function collection(features: EnturGeocoderFeature[] = [STOP]) {
  return {
    type: "FeatureCollection",
    features,
    metadata: {
      query: { limit: 10, lang: "en" },
      resultCount: features.length,
      timestamp: "2026-10-19T09:50:00Z",
    },
  };
}
export function fixture(
  options: {
    responder?: FakeHttpResponder;
    allowed?: (id: string) => Promise<boolean>;
    config?: Record<string, unknown>;
  } = {},
) {
  const http = fakeHttpClient(options.responder ?? (() => JSON.stringify(collection())));
  const ctx = createMockIntegrationContext({
    id: "geocoding-entur",
    manifest: manifest as never,
    http,
    config: options.config ?? {},
  });
  const contributors = Object.fromEntries(
    ["entur-geocoder", ...Object.values(ENTUR_GEOCODER_SUPPLIER_SOURCE_IDS)].map((id) => [
      id,
      [{ sourceId: id, name: id }],
    ]),
  );
  const isSourceAllowed = options.allowed ?? (async () => true);
  const sources = createEnturGeocoderSources({ contributors, isSourceAllowed });
  const client = createEnturClient({
    http,
    config: {
      clientName: "openmapx-tests",
      geocoderEndpoint: options.config?.endpoint as string | undefined,
    },
    sourceIds: { geocoder: "entur-geocoder" },
    contributors,
    isSourceAllowed,
  });
  const geocoder = createEnturGeocoder(client, { timeoutMs: 4000, policy: sources });
  const generation = new AbortController();
  return {
    http,
    ctx,
    generation,
    client,
    sources,
    ...createEnturGeocodingProvider({
      geocoder,
      sources,
      signal: generation.signal,
      country: "no",
      multiModal: "parent",
    }),
  };
}
