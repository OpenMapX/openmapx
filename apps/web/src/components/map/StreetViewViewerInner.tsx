"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PlaceIcon from "@mui/icons-material/Place";
import StreetviewIcon from "@mui/icons-material/Streetview";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { LngLat } from "@openmapx/core";
import {
  useDirectionsStore,
  usePlaceStore,
  useReverseGeocoding,
  useSearchStore,
  useStreetViewStore,
} from "@openmapx/core";
import type { Viewer as MapillaryViewer, ViewerImageEvent } from "mapillary-js";
import { useEffect, useRef, useState } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { useMap } from "@/lib/MapContext";

export default function StreetViewViewerInner() {
  const activeImageId = useStreetViewStore((s) => s.activeImageId);
  const closeViewer = useStreetViewStore((s) => s.closeViewer);
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const setSelectedPlace = usePlaceStore((s) => s.setSelectedPlace);
  const directionsOpen = useDirectionsStore((s) => s.isOpen);
  const setQuery = useSearchStore((s) => s.setQuery);
  const setIsFocused = useSearchStore((s) => s.setIsFocused);

  const { flyTo } = useMap();
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<MapillaryViewer | null>(null);
  const activeImageIdRef = useRef<string | null>(activeImageId);

  type ImageMeta = { lngLat: LngLat; capturedAt: number };
  const [imageMeta, setImageMeta] = useState<ImageMeta | null>(null);
  const [debouncedMeta, setDebouncedMeta] = useState<ImageMeta | null>(null);
  const isFirstImage = useRef(true);

  // Apply immediately on first image, debounce subsequent navigations by 1 s
  useEffect(() => {
    if (imageMeta === null) return;
    if (isFirstImage.current) {
      isFirstImage.current = false;
      setDebouncedMeta(imageMeta);
      return;
    }
    const timer = setTimeout(() => setDebouncedMeta(imageMeta), 1000);
    return () => clearTimeout(timer);
  }, [imageMeta]);

  const { data: reverseGeo } = useReverseGeocoding(debouncedMeta?.lngLat ?? null);

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

      viewer.on("image", (e: ViewerImageEvent) => {
        const { lat, lng } = e.image.lngLat;
        setImageMeta({ lngLat: [lng, lat], capturedAt: e.image.capturedAt });
      });

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

  const captureDate =
    debouncedMeta !== null
      ? new Date(debouncedMeta.capturedAt).toLocaleDateString("en-US", {
          month: "short",
          year: "numeric",
        })
      : null;

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

      {/* Info card — top-left, below the search bar */}
      {(reverseGeo ?? captureDate) && (
        <Box
          sx={{
            position: "absolute",
            top: 80,
            left: 12,
            zIndex: 10,
            bgcolor: "rgba(30,30,30,0.9)",
            borderRadius: "12px",
            p: "12px 14px",
            minWidth: 260,
            maxWidth: 340,
            color: "#fff",
            backdropFilter: "blur(4px)",
          }}
        >
          {/* Header: back arrow + address + vertical sep + pin + dots */}
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1 }}>
            <IconButton
              size="small"
              onClick={closeViewer}
              sx={{ color: "#fff", p: 0, mt: 0.3, flexShrink: 0 }}
              aria-label="Back"
            >
              <ArrowBackIcon sx={{ fontSize: 20 }} />
            </IconButton>

            <Box sx={{ flex: 1, minWidth: 0 }}>
              <Typography
                sx={{
                  fontWeight: 700,
                  fontSize: 15,
                  lineHeight: 1.3,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {reverseGeo?.address ?? "Unknown location"}
              </Typography>
              {reverseGeo?.city && (
                <Typography sx={{ fontSize: 12, color: "rgba(255,255,255,0.65)", mt: 0.25 }}>
                  {reverseGeo.city}
                </Typography>
              )}
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", flexShrink: 0, ml: 0.5 }}>
              <Box sx={{ width: "1px", height: 32, bgcolor: "rgba(255,255,255,0.25)", mr: 0.5 }} />
              <IconButton
                size="small"
                onClick={() => {
                  if (debouncedMeta && reverseGeo) {
                    const label = reverseGeo.address;
                    const address = [reverseGeo.address, reverseGeo.city]
                      .filter(Boolean)
                      .join(", ");
                    setQuery(label);
                    setIsFocused(false);
                    flyTo(debouncedMeta.lngLat, 17);
                    setSelectedPlace({
                      id: `streetview-${debouncedMeta.lngLat[0]},${debouncedMeta.lngLat[1]}`,
                      name: label,
                      address,
                      coordinates: debouncedMeta.lngLat,
                      category: "address",
                    });
                  }
                  closeViewer();
                }}
                sx={{ color: "rgba(255,255,255,0.7)", p: 0.5 }}
                aria-label="Show on map"
              >
                <PlaceIcon sx={{ fontSize: 19 }} />
              </IconButton>
              <IconButton size="small" sx={{ color: "rgba(255,255,255,0.7)", p: 0.5 }}>
                <MoreVertIcon sx={{ fontSize: 19 }} />
              </IconButton>
            </Box>
          </Box>

          {/* Source row */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1.25 }}>
            <StreetviewIcon sx={{ fontSize: 20 }} />
            <Typography sx={{ fontSize: 13 }}>Street-level imagery</Typography>
          </Box>

          <Divider sx={{ bgcolor: "rgba(255,255,255,0.2)", my: 1 }} />

          {/* Capture date */}
          <Typography sx={{ fontSize: 12, color: "rgba(255,255,255,0.65)" }}>
            {captureDate ?? ""}
          </Typography>
        </Box>
      )}

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
