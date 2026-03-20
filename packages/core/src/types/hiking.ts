export interface HikingTrailSummary {
  type: "relation";
  id: number;
  name: string;
  group: "INT" | "NAT" | "REG" | "LOC";
  linear: string;
  symbolDescription: string;
  symbolId: string;
}

export interface HikingTrailDetail extends HikingTrailSummary {
  operator?: string;
  bbox: [number, number, number, number];
  length?: number;
  ascent?: number;
  descent?: number;
  from?: string;
  to?: string;
  roundtrip?: boolean;
  description?: string;
  website?: string;
  wikipedia?: Record<string, string>;
  tags: Record<string, string>;
}

export type SacScale =
  | "hiking"
  | "mountain_hiking"
  | "demanding_mountain_hiking"
  | "alpine_hiking"
  | "demanding_alpine_hiking"
  | "difficult_alpine_hiking";

export interface SacGrade {
  scale: SacScale;
  grade: string;
  name: string;
  color: string;
}

export const SAC_GRADES: Record<SacScale, SacGrade> = {
  hiking: { scale: "hiking", grade: "T1", name: "Hiking", color: "#FFD700" },
  mountain_hiking: {
    scale: "mountain_hiking",
    grade: "T2",
    name: "Mountain Hiking",
    color: "#FF8C00",
  },
  demanding_mountain_hiking: {
    scale: "demanding_mountain_hiking",
    grade: "T3",
    name: "Demanding Mountain Hiking",
    color: "#FF4500",
  },
  alpine_hiking: {
    scale: "alpine_hiking",
    grade: "T4",
    name: "Alpine Hiking",
    color: "#DC143C",
  },
  demanding_alpine_hiking: {
    scale: "demanding_alpine_hiking",
    grade: "T5",
    name: "Demanding Alpine Hiking",
    color: "#8B008B",
  },
  difficult_alpine_hiking: {
    scale: "difficult_alpine_hiking",
    grade: "T6",
    name: "Difficult Alpine Hiking",
    color: "#4B0082",
  },
};

export interface HikingGeoJsonFeature {
  type: "Feature";
  geometry: {
    type: "LineString" | "MultiLineString";
    coordinates: number[][] | number[][][];
  };
  properties: Record<string, unknown>;
}

export interface HikingFeatureCollection {
  type: "FeatureCollection";
  features: HikingGeoJsonFeature[];
}

export interface ShelterFeature {
  type: "Feature";
  geometry: { type: "Point"; coordinates: [number, number] };
  properties: {
    id: number;
    name: string;
    type: string;
    altitude: number | null;
    capacity: number | null;
  };
}

export interface ShelterFeatureCollection {
  type: "FeatureCollection";
  features: ShelterFeature[];
}

export interface MountainShelter {
  id: number;
  name: string;
  coordinates: [number, number];
  type: "refuge" | "cabane" | "gite" | "pt_eau" | "pt_passage";
  altitude?: number;
  capacity?: number;
  description?: string;
  url?: string;
}
