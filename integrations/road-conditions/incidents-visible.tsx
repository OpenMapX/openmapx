import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useRoadConditionsStore } from "./store";

/** Whether the incidents are drawn: the overlay is on and its incidents layer is shown. */
export function useIncidentsVisible(): boolean {
  const overlayVisible = useOverlayLayerVisible("road-conditions");
  const showIncidents = useRoadConditionsStore((s) => s.showIncidents);
  return overlayVisible && showIncidents;
}
