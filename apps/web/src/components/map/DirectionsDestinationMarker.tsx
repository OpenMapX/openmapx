"use client";

import { useDirectionsStore } from "@openmapx/core";
import { usePinMarker } from "@/hooks/usePinMarker";

export function DirectionsDestinationMarker() {
  const { isOpen, destination, destinationLabel } = useDirectionsStore();
  usePinMarker(isOpen ? destination : null, destinationLabel, false);
  return null;
}
