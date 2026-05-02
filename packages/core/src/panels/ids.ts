export const PANEL = {
  PLACE: "place",
  CATEGORY: "category",
  DATASOURCE: "datasource",
  DIRECTIONS: "directions",
  SAVED: "saved",
  NEARBY: "nearby",
  PLACE_CARD: "place-card",
} as const;

export type PanelId = (typeof PANEL)[keyof typeof PANEL];
