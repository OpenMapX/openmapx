/**
 * Raw API response types for RIS::Maps v2.5.
 * Internal only.
 */

export interface RisTransportInfo {
  type?: string;
  journeyName?: string;
  label?: string;
  journeyNumber?: number;
  category?: string;
}

export interface RisJourneyPositionEntry {
  journeyID: string;
  latitude: number;
  longitude: number;
  direction?: number; // bearing 0-360
  speed?: number; // km/h
  administrations?: string[];
  info?: {
    transportAtStart?: RisTransportInfo;
    type?: string;
    origin?: { evaNumber?: string; name?: string };
    destination?: { evaNumber?: string; name?: string };
  };
  meta?: { timeCreated?: string; timeInformation?: string };
}

export interface RisPositionsResponse {
  positions?: RisJourneyPositionEntry[];
}

export interface RisEmulatedEntry extends RisJourneyPositionEntry {
  waypoints?: Array<{
    latitude: number;
    longitude: number;
    estimatedTime: string;
    gpsBased: boolean;
  }>;
  delay?: string; // ISO-8601 duration
  category?: string;
  line?: string;
}

export interface RisEmulatedResponse {
  positions?: RisEmulatedEntry[];
}

export interface RisRailwaySectionFeature {
  type: "Feature";
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
  properties: Record<string, unknown>;
}

export interface RisRailwayGeometryResponse {
  type: "FeatureCollection";
  features: RisRailwaySectionFeature[];
}
