/**
 * Raw API response types for RIS::Stations v1.29.
 * Internal only — never exported from the package.
 */

export interface RisPosition {
  longitude: number;
  latitude: number;
}

export interface RisName {
  nameLong: string;
  nameShort?: string;
  speechLong?: string;
  speechShort?: string;
  symbol?: string;
}

export interface RisTransportAssociation {
  type: string; // HIGH_SPEED_TRAIN, INTERCITY_TRAIN, REGIONAL_TRAIN, CITY_TRAIN, SUBWAY, TRAM, BUS, etc.
}

export interface RisStopPlace {
  evaNumber: string;
  names: Record<string, RisName>; // keyed by language (DE, EN, etc.)
  metropolis?: Record<string, string>; // city name by language
  position: RisPosition;
  availableTransports?: RisTransportAssociation[];
  stationID?: string;
  country?: string;
  state?: string;
  timeZone?: string;
}

export interface RisStopPlacesResponse {
  stopPlaces: RisStopPlace[];
}

export interface RisPlatformAccessibility {
  /** Platform height in cm above rail top (e.g. 76, 96). */
  boardingHeight?: number;
  /** Whether step-free boarding is available. */
  stepFreeAccess?: boolean;
  /** Tactile guidance strips available. */
  tactileGuidanceStrips?: boolean;
}

export interface RisPlatform {
  name: string;
  length?: number; // meters
  height?: number; // cm
  accessibility?: RisPlatformAccessibility;
  linkedPlatforms?: string[];
}

export interface RisPlatformsResponse {
  platforms: RisPlatform[];
}

export interface RisConnectingTime {
  fromEvaNumber?: string;
  toEvaNumber?: string;
  type?: string; // COMMUTER, OCCASIONAL, MOBILITY_RESTRICTED
  defaultDuration?: number; // minutes
  reducedDuration?: number;
  extendedDuration?: number;
}

export interface RisConnectingTimesResponse {
  connectingTimes: RisConnectingTime[];
}

export interface RisLocalService {
  name: string;
  category?: string;
  type?: string;
}

export interface RisLocalServicesResponse {
  localServices: RisLocalService[];
}
