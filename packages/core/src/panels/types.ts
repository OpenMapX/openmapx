export type PanelLayer = "sidebar" | "detail";

export interface PanelDefinition {
  id: string;
  layer: PanelLayer;
  zIndex?: number;
  /** Called when panel is deactivated by mutual exclusion. Must be synchronous and idempotent. */
  onDeactivate?: () => void;
}
