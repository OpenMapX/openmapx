import type {
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  PolygonGeometry,
} from "@openmapx/core";

export type {
  LineStringGeometry,
  MultiLineStringGeometry,
  MultiPolygonGeometry,
  OverpassElement,
  OverpassResponse,
  PolygonGeometry,
} from "@openmapx/core";

export interface WinterSportsPiste {
  id: string;
  name: string;
  type: string;
  difficulty: string;
  grooming: string;
  lit: boolean;
  snowmaking: boolean;
  ref: string;
  geometry: LineStringGeometry | MultiLineStringGeometry;
}

export interface WinterSportsLift {
  id: string;
  name: string;
  aerialway: string;
  occupancy: number | null;
  capacity: number | null;
  duration: number | null;
  detachable: boolean | null;
  bubble: boolean | null;
  heating: boolean | null;
  geometry: LineStringGeometry;
}

export interface WinterSportsArea {
  id: string;
  name: string;
  geometry: PolygonGeometry | MultiPolygonGeometry;
}

export interface WinterSportsFeaturesResponse {
  pistes: WinterSportsPiste[];
  lifts: WinterSportsLift[];
  areas: WinterSportsArea[];
}
