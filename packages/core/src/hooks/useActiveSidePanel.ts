import { useDirectionsStore } from "../stores/directionsStore";
import { usePlaceStore } from "../stores/placeStore";

/**
 * Returns whether any sidebar panel is currently visible and a unified close callback.
 * Extend this hook when new sidebar types are added (layers, etc.) so that
 * the SearchBar and any other consumer never need to know which specific panel is open.
 */
export function useActiveSidePanel() {
  const { selectedPlace, setSelectedPlace } = usePlaceStore();
  const { isOpen: directionsOpen, close: closeDirections } = useDirectionsStore();

  const isOpen = selectedPlace !== null || directionsOpen;

  const close = () => {
    setSelectedPlace(null);
    closeDirections();
  };

  return { isOpen, close };
}
