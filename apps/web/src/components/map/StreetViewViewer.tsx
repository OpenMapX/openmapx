"use client";

import { useStreetViewStore } from "@integrations/street-view-mapillary/store";
import { useDirectionsStore } from "@openmapx/core";
import dynamic from "next/dynamic";
import { useEffect } from "react";

const StreetViewViewerInner = dynamic(() => import("./StreetViewViewerInner"), { ssr: false });

export function StreetViewViewer() {
  const activeImageId = useStreetViewStore((s) => s.activeImageId);
  const closeDirections = useDirectionsStore((s) => s.close);

  // Ensure directions panel is closed whenever the viewer opens so the
  // SearchBar (which returns null while directionsOpen=true) is always visible.
  useEffect(() => {
    if (activeImageId !== null) closeDirections();
  }, [activeImageId, closeDirections]);

  if (!activeImageId) return null;
  return <StreetViewViewerInner />;
}
