/**
 * RIS::Stations geocoding provider and station detail service.
 *
 * Geocoding: fuzzy station name search via /stop-places/by-name
 * Detail: full station data (platforms, transfer times, services) via multiple endpoints
 */

import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";
import { createRisClient, type RisCredentials } from "@openmapx/core/ris-client";
import type { GeocodingProvider as GeocodingProviderImpl } from "@openmapx/integration-geocoding/types";
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

let risClient = createRisClient();

export function setRisCredentials(credentials: RisCredentials): void {
  risClient = createRisClient(credentials);
}

async function searchStopPlaces(query: string, limit = 6): Promise<RisStopPlace[]> {
  const encoded = encodeURIComponent(query);
  const data = await risClient.get<RisStopPlacesResponse>(
    "stations",
    `/stop-places/by-name/${encoded}?limit=${limit}`,
  );
  return data.stopPlaces ?? [];
}

async function getStopPlaceByEva(evaNumber: string): Promise<RisStopPlace> {
  return risClient.get<RisStopPlace>("stations", `/stop-places/${evaNumber}`);
}

async function getStopPlacesByPosition(
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

async function getPlatforms(evaNumber: string): Promise<RisPlatformsResponse> {
  return risClient.get<RisPlatformsResponse>("stations", `/platforms/${evaNumber}`);
}

async function getConnectingTimes(evaNumber: string): Promise<RisConnectingTimesResponse> {
  return risClient.get<RisConnectingTimesResponse>("stations", `/connecting-times/${evaNumber}`);
}

async function getLocalServices(evaNumber: string): Promise<RisLocalServicesResponse> {
  return risClient.get<RisLocalServicesResponse>(
    "stations",
    `/local-services/by-key?keyType=EVA&key=${evaNumber}`,
  );
}

export const dbRisGeocodingService: GeocodingProviderImpl = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
    if (!risClient.isConfigured()) return [];
    try {
      const stops = await searchStopPlaces(query, 10);
      return stops.map((s) => stopPlaceToSearchResult(s, lang));
    } catch {
      return [];
    }
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    if (!risClient.isConfigured()) return [];
    try {
      const stops = await searchStopPlaces(query, 6);
      return stops.map((s) => stopPlaceToAutocompleteResult(s, lang));
    } catch {
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
      const stops = await getStopPlacesByPosition(lat, lng, 200, 1);
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

export async function lookupDbStation(
  evaNumber: string,
  lang?: string,
): Promise<Record<string, unknown>> {
  const stop = await getStopPlaceByEva(evaNumber);
  const place = stopPlaceToPlace(stop, lang);

  const [platformsResult, timesResult, servicesResult] = await Promise.allSettled([
    getPlatforms(evaNumber),
    getConnectingTimes(evaNumber),
    getLocalServices(evaNumber),
  ]);

  const platforms =
    platformsResult.status === "fulfilled" ? (platformsResult.value.platforms ?? []) : [];
  const times = timesResult.status === "fulfilled" ? (timesResult.value.connectingTimes ?? []) : [];
  const services =
    servicesResult.status === "fulfilled" ? (servicesResult.value.localServices ?? []) : [];

  const detail = buildStationDetail(platforms, times, services);

  return { ...place, dataSourceDetail: detail };
}
