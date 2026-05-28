/**
 * Maps RIS::Stations API responses to OpenMapX types.
 * Pure functions — no I/O.
 */

import {
  type AutocompleteResult,
  createPlace,
  type Place,
  type SearchResult,
} from "@openmapx/core";
import { type I18nToken, type Translatable, token } from "@openmapx/integration-framework/strings";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import type {
  RisConnectingTime,
  RisLocalService,
  RisPlatform,
  RisStopPlace,
} from "./stations-types.js";

const RIS_TRANSPORT_MODE: Record<string, TransportMode> = {
  HIGH_SPEED_TRAIN: "rail",
  INTERCITY_TRAIN: "rail",
  INTER_REGIONAL_TRAIN: "rail",
  REGIONAL_TRAIN: "rail",
  CITY_TRAIN: "rail",
  SUBURBAN: "rail",
  SUBWAY: "subway",
  TRAM: "tram",
  BUS: "bus",
  FERRY: "ferry",
};

function stopName(stop: RisStopPlace, lang?: string): string {
  const key = lang?.toUpperCase() ?? "DE";
  const names = stop.names[key] ?? stop.names.DE ?? Object.values(stop.names)[0];
  return names?.nameLong ?? `EVA ${stop.evaNumber}`;
}

function stopCity(stop: RisStopPlace, lang?: string): string {
  if (!stop.metropolis) return "";
  const key = lang?.toUpperCase() ?? "DE";
  return stop.metropolis[key] ?? stop.metropolis.DE ?? Object.values(stop.metropolis)[0] ?? "";
}

function uniqueModes(associations: RisStopPlace["availableTransports"]): TransportMode[] {
  if (!associations?.length) return ["rail"];
  const modes = new Set<TransportMode>();
  for (const a of associations) {
    const mode = RIS_TRANSPORT_MODE[a.type];
    if (mode) modes.add(mode);
  }
  return modes.size > 0 ? [...modes] : ["rail"];
}

export function stopPlaceToSearchResult(stop: RisStopPlace, lang?: string): SearchResult {
  const name = stopName(stop, lang);
  const city = stopCity(stop, lang);
  return {
    id: `eva:${stop.evaNumber}`,
    label: city ? `${name}, ${city}` : name,
    coordinates: [stop.position.longitude, stop.position.latitude],
    type: "poi",
    confidence: 1,
    rawCategory: "railway/station",
  };
}

export function stopPlaceToAutocompleteResult(
  stop: RisStopPlace,
  lang?: string,
): AutocompleteResult {
  const name = stopName(stop, lang);
  const city = stopCity(stop, lang);
  const transitStop: TransitStop = {
    id: `eva:${stop.evaNumber}`,
    name,
    lat: stop.position.latitude,
    lng: stop.position.longitude,
    modes: uniqueModes(stop.availableTransports),
    provider: "db-ris",
  };
  return {
    id: `eva:${stop.evaNumber}`,
    label: name,
    sublabel: city || undefined,
    coordinates: [stop.position.longitude, stop.position.latitude],
    type: "transit_stop",
    transitStop,
    rawCategory: "railway/station",
  };
}

export function stopPlaceToPlace(stop: RisStopPlace, lang?: string): Place {
  const name = stopName(stop, lang);
  const city = stopCity(stop, lang);
  return createPlace({
    primaryScheme: "eva",
    ids: { eva: stop.evaNumber },
    name,
    address: name,
    city: city || undefined,
    coordinates: [stop.position.longitude, stop.position.latitude],
    category: "Train Station",
    rawCategory: "railway/station",
  });
}

export interface StationDetail {
  source: string;
  attribution: { text: string; url: string; license: string; licenseUrl: string };
  sections: StationDetailSection[];
}

interface StationDetailSection {
  title: I18nToken;
  type: "table" | "list";
  collapsed?: boolean;
  rows?: Translatable[][];
  items?: (I18nToken | string)[];
}

const TRAVELER_TYPE_TOKEN: Record<string, I18nToken> = {
  COMMUTER: token("value.travelerStandard"),
  OCCASIONAL: token("value.travelerOccasional"),
  MOBILITY_RESTRICTED: token("value.travelerMobilityRestricted"),
};

function travelerTypeLabel(type: string | undefined): Translatable {
  if (!type) return TRAVELER_TYPE_TOKEN.COMMUTER;
  return TRAVELER_TYPE_TOKEN[type] ?? type;
}

export function buildStationDetail(
  platforms: RisPlatform[],
  connectingTimes: RisConnectingTime[],
  localServices: RisLocalService[],
): StationDetail {
  const sections: StationDetailSection[] = [];

  if (platforms.length > 0) {
    sections.push({
      title: token("section.platforms"),
      type: "table",
      rows: platforms.map((p) => [
        p.name,
        p.length ? token("value.metersValue", { count: p.length }) : "-",
        p.height ? token("value.centimetersValue", { count: p.height }) : "-",
        p.accessibility?.stepFreeAccess ? token("value.stepFree") : "-",
      ]),
    });
  }

  if (connectingTimes.length > 0) {
    sections.push({
      title: token("section.transferTimes"),
      type: "table",
      collapsed: true,
      rows: connectingTimes.map((ct) => [
        travelerTypeLabel(ct.type),
        ct.defaultDuration ? token("value.minutesValue", { count: ct.defaultDuration }) : "-",
      ]),
    });
  }

  if (localServices.length > 0) {
    sections.push({
      title: token("section.localServices"),
      type: "list",
      collapsed: true,
      items: localServices.map((s) => (s.category ? `${s.name} (${s.category})` : s.name)),
    });
  }

  return {
    source: "db-station",
    attribution: {
      text: "Deutsche Bahn",
      url: "https://developers.deutschebahn.com",
      license: "DB API Terms",
      licenseUrl: "https://developers.deutschebahn.com",
    },
    sections,
  };
}
