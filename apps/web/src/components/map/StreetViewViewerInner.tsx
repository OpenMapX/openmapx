"use client";

import CloseIcon from "@mui/icons-material/Close";
import IconButton from "@mui/material/IconButton";
import { useDirectionsStore, usePlaceStore, useStreetViewStore } from "@openmapx/core";
import type { Viewer as MapillaryViewer } from "mapillary-js";
import { useEffect, useRef } from "react";
import { SearchBar } from "@/components/search/SearchBar";

export default function StreetViewViewerInner() {
  const activeImageId = useStreetViewStore((s) => s.activeImageId);
  const closeViewer = useStreetViewStore((s) => s.closeViewer);
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const directionsOpen = useDirectionsStore((s) => s.isOpen);

  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MapillaryViewer | null>(null);
  const activeImageIdRef = useRef<string | null>(activeImageId);

  // Close viewer when the user selects a place from search (but not on initial mount)
  const prevSelectedPlace = useRef(selectedPlace);
  useEffect(() => {
    if (selectedPlace !== prevSelectedPlace.current && selectedPlace !== null) {
      closeViewer();
    }
    prevSelectedPlace.current = selectedPlace;
  }, [selectedPlace, closeViewer]);

  // Close viewer when directions panel opens
  const prevDirectionsOpen = useRef(directionsOpen);
  useEffect(() => {
    if (directionsOpen && !prevDirectionsOpen.current) {
      closeViewer();
    }
    prevDirectionsOpen.current = directionsOpen;
  }, [directionsOpen, closeViewer]);

  // Keep activeImageIdRef current so the init effect can read it after async init
  useEffect(() => {
    activeImageIdRef.current = activeImageId;
  }, [activeImageId]);

  // Initialize viewer once on mount
  useEffect(() => {
    const token = process.env.NEXT_PUBLIC_MAPILLARY_TOKEN ?? "";
    const container = containerRef.current;
    if (!container) return;

    let unmounted = false;

    void (async () => {
      const { Viewer } = await import("mapillary-js");
      if (unmounted) return;

      const viewer = new Viewer({ accessToken: token, container });
      viewerRef.current = viewer;

      const initialId = activeImageIdRef.current;
      if (initialId) {
        void viewer.moveTo(initialId).catch(() => {});
      }
    })();

    return () => {
      unmounted = true;
      viewerRef.current?.remove();
      viewerRef.current = null;
    };
  }, []);

  // Navigate when activeImageId changes after mount
  useEffect(() => {
    if (!activeImageId || !viewerRef.current) return;
    void viewerRef.current.moveTo(activeImageId).catch(() => {});
  }, [activeImageId]);

  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        zIndex: 30,
        background: "#000",
      }}
    >
      <div ref={containerRef} style={{ width: "100%", height: "100%" }} />

      {/* Search bar floats above the viewer at its normal top-left position */}
      <SearchBar />

      <IconButton
        onClick={closeViewer}
        aria-label="Close Street-level imagery viewer"
        sx={{
          position: "absolute",
          top: 8,
          right: 8,
          bgcolor: "rgba(0,0,0,0.5)",
          color: "#fff",
          borderRadius: "50%",
          p: 1.2,
          "&:hover": { bgcolor: "rgba(0,0,0,0.7)" },
        }}
      >
        <CloseIcon />
      </IconButton>
    </div>
  );
}
