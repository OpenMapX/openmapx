import { useCrowdReportStore } from "@integrations/crowd-reports/store";
import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import { configureMapClickOwnership } from "@/integration-api/map/mapClickOwnership";

function readToolOwner() {
  if (useCrowdReportStore.getState().picking) return "crowd" as const;
  if (useMeasurementStore.getState().isActive) return "measurement" as const;
  const travel = useTravelTimeStore.getState();
  return travel.isActive && !travel.anchored ? ("travel-time" as const) : null;
}

/** Install host mode state before creating a map or mounting its click handlers. */
export function initializeMapClickModes(): void {
  configureMapClickOwnership(readToolOwner);
}
