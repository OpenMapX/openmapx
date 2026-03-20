/** Unified types for all Overpass API interactions. */

export interface OverpassNode {
  type: "node";
  id: number;
  lat: number;
  lon: number;
  tags?: Record<string, string>;
}

export interface OverpassWay {
  type: "way";
  id: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
  nodes?: number[];
}

export interface OverpassRelation {
  type: "relation";
  id: number;
  tags?: Record<string, string>;
  members?: OverpassMember[];
}

export interface OverpassMember {
  type: string;
  ref: number;
  role: string;
  geometry?: Array<{ lat: number; lon: number }>;
}

export type OverpassElement = OverpassNode | OverpassWay | OverpassRelation;

/** Generic Overpass response with optional `remark` for error diagnostics. */
export interface OverpassResponse {
  elements: OverpassElement[];
  remark?: string;
}

export interface LineStringGeometry {
  type: "LineString";
  coordinates: [number, number][];
}

export interface MultiLineStringGeometry {
  type: "MultiLineString";
  coordinates: [number, number][][];
}

export interface PolygonGeometry {
  type: "Polygon";
  coordinates: [number, number][][];
}

export interface MultiPolygonGeometry {
  type: "MultiPolygon";
  coordinates: [number, number][][][];
}
