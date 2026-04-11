/**
 * RIS::Stations geocoding provider and station detail service.
 *
 * Geocoding: fuzzy station name search via /stop-places/by-name
 * Detail: full station data (platforms, transfer times, services) via multiple endpoints
 */

import type { AutocompleteResult, ReverseGeocodingResult, SearchResult } from "@openmapx/core";
import type { GeocodingProvider } from "../../../../../integrations/geocoding/types.js";
import { isRisConfigured, risGet } from "./client.js";
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

async function searchStopPlaces(query: string, limit = 6): Promise<RisStopPlace[]> {
  const encoded = encodeURIComponent(query);
  const data = await risGet<RisStopPlacesResponse>(
    "stations",
    `/stop-places/by-name/${encoded}?limit=${limit}`,
  );
  return data.stopPlaces ?? [];
}

async function getStopPlaceByEva(evaNumber: string): Promise<RisStopPlace> {
  return risGet<RisStopPlace>("stations", `/stop-places/${evaNumber}`);
}

async function getStopPlacesByPosition(
  lat: number,
  lng: number,
  radius = 500,
  limit = 5,
): Promise<RisStopPlace[]> {
  const data = await risGet<RisStopPlacesResponse>(
    "stations",
    `/stop-places/by-position?latitude=${lat}&longitude=${lng}&radius=${radius}&limit=${limit}`,
  );
  return data.stopPlaces ?? [];
}

async function getPlatforms(evaNumber: string): Promise<RisPlatformsResponse> {
  return risGet<RisPlatformsResponse>("stations", `/platforms/${evaNumber}`);
}

async function getConnectingTimes(evaNumber: string): Promise<RisConnectingTimesResponse> {
  return risGet<RisConnectingTimesResponse>("stations", `/connecting-times/${evaNumber}`);
}

async function getLocalServices(evaNumber: string): Promise<RisLocalServicesResponse> {
  return risGet<RisLocalServicesResponse>(
    "stations",
    `/local-services/by-key?keyType=EVA&key=${evaNumber}`,
  );
}

// Geocoding provider

export const dbRisGeocodingService: GeocodingProvider = {
  async geocode(query: string, lang?: string): Promise<SearchResult[]> {
    if (!isRisConfigured()) return [];
    try {
      const stops = await searchStopPlaces(query, 10);
      return stops.map((s) => stopPlaceToSearchResult(s, lang));
    } catch {
      return [];
    }
  },

  async autocomplete(query: string, lang?: string): Promise<AutocompleteResult[]> {
    if (!isRisConfigured()) return [];
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
    if (!isRisConfigured()) return null;
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

// Station detail lookup (used by places route for db-<evaNumber> IDs)

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
