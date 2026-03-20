"use client";

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import CloseIcon from "@mui/icons-material/Close";
import MoreVertIcon from "@mui/icons-material/MoreVert";
import PlaceIcon from "@mui/icons-material/Place";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { LngLat } from "@openmapx/core";
import {
  PANEL,
  useDirectionsStore,
  usePlaceStore,
  useReverseGeocoding,
  useSearchStore,
  useSidebarStore,
  useStreetViewStore,
} from "@openmapx/core";
import type { Viewer as MapillaryViewer, ViewerImageEvent } from "mapillary-js";
import { useLocale, useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { SearchBar } from "@/components/search/SearchBar";
import { useMap } from "@/lib/MapContext";

export default function StreetViewViewerInner() {
  const t = useTranslations("streetView");
  const tc = useTranslations("common");
  const locale = useLocale();
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
      ? new Date(debouncedMeta.capturedAt).toLocaleDateString(locale, {
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
              aria-label={tc("back")}
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
                {reverseGeo?.address ?? t("unknownLocation")}
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
                    useSidebarStore.getState().openSidebar(PANEL.PLACE);
                  }
                  closeViewer();
                }}
                sx={{ color: "rgba(255,255,255,0.7)", p: 0.5 }}
                aria-label={t("showOnMap")}
              >
                <PlaceIcon sx={{ fontSize: 19 }} />
              </IconButton>
              <IconButton
                size="small"
                sx={{ color: "rgba(255,255,255,0.7)", p: 0.5 }}
                aria-label={t("moreOptions")}
              >
                <MoreVertIcon sx={{ fontSize: 19 }} />
              </IconButton>
            </Box>
          </Box>

          {/* Source row */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 1.25 }}>
            <svg
              viewBox="-15 -15 65 65"
              width="24"
              height="24"
              style={{ flexShrink: 0 }}
              aria-label="Mapillary"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
            >
              <defs>
                <clipPath id="mapillary-logo-clip">
                  <circle cx="17.5" cy="17.5" r="32.5" />
                </clipPath>
              </defs>
              <circle cx="17.5" cy="17.5" r="32.5" fill="#05cb63" />
              <path
                fill="#FFF"
                fillRule="evenodd"
                clipRule="evenodd"
                clipPath="url(#mapillary-logo-clip)"
                d="M16.468 25.735c.624.327 15.734 8.542 16.21 8.807.954.528 1.963-.494 1.444-1.45-.261-.48-8.446-15.977-8.722-16.451-.276-.475-.956-.714-1.467-.396-.5.312-1.077.663-1.4.832-.651.34-.731.851-.439 1.42.643 1.248 2.664 5.038 2.896 5.435.484.831-.596 1.78-1.329 1.366-.31-.176-5.107-2.768-5.446-2.971-.339-.203-.94-.201-1.351.484a53.63 53.63 0 00-.837 1.425c-.334.61-.182 1.172.441 1.499zM.517 17.069c-.805-.448-.658-1.613.357-1.91.86-.252 7.844-2.657 9.957-3.386.382-.131.679-.434.807-.82L15.032.724c.317-.957 1.466-.96 1.935-.034.166.33 6.49 12.106 6.71 12.606.22.5.078 1.053-.42 1.372-.5.319-1.312.796-1.596.977-.513.328-1.004.1-1.238-.408-.234-.507-2.038-3.78-2.774-5.169-.368-.694-1.476-.96-1.848.162l-1.224 3.689a1.343 1.343 0 01-.812.827l-3.683 1.254c-.727.247-1.08 1.392-.099 1.874.205.1 4.626 2.538 5.082 2.76.457.224.71.867.443 1.323-.364.622-.83 1.411-1 1.668-.293.444-.87.591-1.353.33C12.671 23.69.804 17.228.517 17.068z"
              />
            </svg>
            <Typography sx={{ fontSize: 13 }}>Mapillary</Typography>
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
        aria-label={tc("close")}
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
