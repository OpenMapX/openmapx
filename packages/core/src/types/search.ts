export type SpatialConstraint =
  | { type: "near_place"; place_name: string }
  | { type: "near_coordinates"; lat: number; lng: number }
  | { type: "within_bbox"; south: number; west: number; north: number; east: number }
  | { type: "current_view" };

export type TimeConstraint =
  | { type: "open_now" }
  | { type: "open_at"; day: string; time: string }
  | { type: "open_24h" };

export interface SearchIntent {
  categories: string[];
  attributes: Record<string, string>;
  spatial_constraint: SpatialConstraint | null;
  time_constraint: TimeConstraint | null;
  sort_by: "relevance" | "distance" | "rating";
  unmapped_attributes: string[];
  confidence: number;
  explanation: string;
}
