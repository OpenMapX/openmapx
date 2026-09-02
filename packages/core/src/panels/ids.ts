export const PANEL = {
  PLACE: "place",
  CATEGORY: "category",
  DATASOURCE: "datasource",
  DIRECTIONS: "directions",
  SAVED: "saved",
  PARKING: "parking",
  TIMELINE: "timeline",
  PLACE_CARD: "place-card",
} as const;

export type PanelId = (typeof PANEL)[keyof typeof PANEL];
