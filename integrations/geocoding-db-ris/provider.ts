/**
 * RIS::Stations geocoding provider and station detail service.
 *
 * Geocoding: fuzzy station name search via /stop-places/by-name
 * Detail: full station data (platforms, transfer times, services) via multiple endpoints
 */

import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";
import type { ProviderCallContext } from "@openmapx/integration-framework";
import type {
  GeocodingBias,
  GeocodingProvider as GeocodingProviderImpl,
} from "@openmapx/integration-geocoding/types";
import type { RisClient } from "@openmapx/mobility-core/ris-client";
import {
  buildStationDetail,
  stopPlaceToAutocompleteResult,
  stopPlaceToPlace,
  stopPlaceToSearchResult,
} from "./stations-mapper.js";
import type {
  RisConnectingTimesResponse,
  RisLocalServicesResponse,
  RisPlatformsResponse,
  RisStopPlace,
  RisStopPlacesResponse,
} from "./stations-types.js";

async function searchStopPlaces(
  risClient: RisClient,
  query: string,
  limit = 6,
  signal?: AbortSignal,
): Promise<RisStopPlace[]> {
  const encoded = encodeURIComponent(query);
  const data = await risClient.get<RisStopPlacesResponse>(
    "stations",
    `/stop-places/by-name/${encoded}?limit=${limit}`,
    undefined,
    signal,
  );
  return data.stopPlaces ?? [];
}

async function getStopPlaceByEva(risClient: RisClient, evaNumber: string): Promise<RisStopPlace> {
  return risClient.get<RisStopPlace>("stations", `/stop-places/${evaNumber}`);
}

async function getStopPlacesByPosition(
  risClient: RisClient,
  lat: number,
  lng: number,
  radius = 500,
  limit = 5,
): Promise<RisStopPlace[]> {
  const data = await risClient.get<RisStopPlacesResponse>(
    "stations",
    `/stop-places/by-position?latitude=${lat}&longitude=${lng}&radius=${radius}&limit=${limit}`,
  );
  return data.stopPlaces ?? [];
}

async function getPlatforms(
  risClient: RisClient,
  evaNumber: string,
): Promise<RisPlatformsResponse> {
  return risClient.get<RisPlatformsResponse>("stations", `/platforms/${evaNumber}`);
}

async function getConnectingTimes(
  risClient: RisClient,
  evaNumber: string,
): Promise<RisConnectingTimesResponse> {
  return risClient.get<RisConnectingTimesResponse>("stations", `/connecting-times/${evaNumber}`);
}

async function getLocalServices(
  risClient: RisClient,
  evaNumber: string,
): Promise<RisLocalServicesResponse> {
  return risClient.get<RisLocalServicesResponse>(
    "stations",
    `/local-services/by-key?keyType=EVA&key=${evaNumber}`,
  );
}

/** RIS::Stations geocoding through one generation's RIS client. */
export function createDbRisGeocodingService(risClient: RisClient): GeocodingProviderImpl {
  return {
    async geocode(query: string, lang?: string): Promise<SearchResult[]> {
      if (!risClient.isConfigured()) return [];
      try {
        const stops = await searchStopPlaces(risClient, query, 10);
        return stops.map((s) => stopPlaceToSearchResult(s, lang));
      } catch {
        return [];
      }
    },

    async autocomplete(
      query: string,
      lang?: string,
      _bias?: GeocodingBias,
      context?: Pick<ProviderCallContext, "signal">,
    ): Promise<AutocompleteResult[]> {
      context?.signal.throwIfAborted();
      if (!risClient.isConfigured()) return [];
      try {
        const stops = await searchStopPlaces(risClient, query, 6, context?.signal);
        return stops.map((s) => stopPlaceToAutocompleteResult(s, lang));
      } catch {
        context?.signal.throwIfAborted();
        return [];
      }
    },

    async reverseGeocode(
      lat: number,
      lng: number,
      lang?: string,
    ): Promise<ReverseGeocodingResult | null> {
      if (!risClient.isConfigured()) return null;
      try {
        const stops = await getStopPlacesByPosition(risClient, lat, lng, 200, 1);
        if (!stops[0]) return null;
        const name =
          stops[0].names[lang?.toUpperCase() ?? "DE"]?.nameLong ??
          stops[0].names.DE?.nameLong ??
          `EVA ${stops[0].evaNumber}`;
        const city =
          stops[0].metropolis?.[lang?.toUpperCase() ?? "DE"] ?? stops[0].metropolis?.DE ?? "";
        return { address: name, city };
      } catch {
        return null;
      }
    },
  };
}

export async function lookupDbStation(
  risClient: RisClient,
  evaNumber: string,
  lang?: string,
): Promise<Record<string, unknown>> {
  const stop = await getStopPlaceByEva(risClient, evaNumber);
  const place = stopPlaceToPlace(stop, lang);

  const [platformsResult, timesResult, servicesResult] = await Promise.allSettled([
    getPlatforms(risClient, evaNumber),
    getConnectingTimes(risClient, evaNumber),
    getLocalServices(risClient, evaNumber),
  ]);

  const platforms =
    platformsResult.status === "fulfilled" ? (platformsResult.value.platforms ?? []) : [];
  const times = timesResult.status === "fulfilled" ? (timesResult.value.connectingTimes ?? []) : [];
  const services =
    servicesResult.status === "fulfilled" ? (servicesResult.value.localServices ?? []) : [];

  const detail = buildStationDetail(platforms, times, services);

  return { ...place, dataSourceDetail: detail };
}
