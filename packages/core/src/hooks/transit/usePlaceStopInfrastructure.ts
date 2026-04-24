import type { Place } from "../../types/place";
import {
  resolvePrimaryTransitStopId,
  resolvePrimaryTransitStopIdFromLinkedStops,
} from "./resolvePrimaryTransitStopId";
import { useLinkedTransitStops } from "./useLinkedTransitStops";
import { useStopInfrastructure } from "./useStopInfrastructure";

export function usePlaceStopInfrastructure(place: Place | null) {
  const directStopId = place ? resolvePrimaryTransitStopId(place) : null;
  const linkedStops = useLinkedTransitStops(place, { enabled: directStopId === null });
  const resolvedStopId =
    directStopId ?? resolvePrimaryTransitStopIdFromLinkedStops(linkedStops.data);
  const infrastructure = useStopInfrastructure(resolvedStopId);

  return {
    ...infrastructure,
    resolvedStopId,
    isLoading:
      (directStopId === null && linkedStops.isLoading && resolvedStopId === null) ||
      infrastructure.isLoading,
  };
}
