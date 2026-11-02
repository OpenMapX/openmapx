"use client";

import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DirectionsIcon from "@mui/icons-material/Directions";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import ShareIcon from "@mui/icons-material/Share";
import TripOriginIcon from "@mui/icons-material/TripOrigin";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  coordinateId,
  createPlace,
  PANEL,
  type Place,
  useMapClickStore,
  usePlaceStore,
  useReverseGeocoding,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useMemo, useState, useSyncExternalStore } from "react";
import { useSaveParking } from "@/components/panels/parking/useSaveParking";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { routeFromOrTo, shareLocationLink } from "@/lib/locationActions";
import { useMapFooterBox } from "@/lib/mapFooterCenter";
import { subscribeMobileFooterSurfaces, topMobileFooterSurface } from "@/lib/mobileFooterSurface";
import { useBackDismiss } from "@/lib/useBackDismiss";

const CARD_GAP = 8;

function sheetTop(): number | null {
  const surface = topMobileFooterSurface();
  return surface ? surface.bottom - surface.visibleHeight : null;
}

/**
 * Where the phone card rests: above an open sheet, or above the map footer —
 * never over the map credits, which have to stay readable.
 */
function usePhoneCardBottom(): string {
  const footer = useMapFooterBox();
  const top = useSyncExternalStore(subscribeMobileFooterSurfaces, sheetTop, () => null);
  if (top !== null) return `${Math.max(0, window.innerHeight - top) + CARD_GAP}px`;
  return `calc(var(--omx-map-footer-bottom, var(--omx-safe-bottom)) + ${footer.height + CARD_GAP}px)`;
}

export function MapClickFloatingCard() {
  const tc = useTranslations("common");
  const tp = useTranslations("place");
  const tm = useTranslations("mapContextMenu");
  const tParking = useTranslations("parking");
  const locale = useLocale();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { clickedLngLat, setClickedLngLat } = useMapClickStore();
  const { setQuery, setIsFocused } = useSearchStore();
  const { flyTo } = useMap();
  const { saveAt } = useSaveParking();
  const [feedback, setFeedback] = useState<string | null>(null);
  const phoneCardBottom = usePhoneCardBottom();

  const { data: reverseGeo, isLoading } = useReverseGeocoding(clickedLngLat, locale);
  useBackDismiss(clickedLngLat !== null, () => setClickedLngLat(null));

  const coordLabel = clickedLngLat
    ? `${clickedLngLat[1].toFixed(6)}, ${clickedLngLat[0].toFixed(6)}`
    : "";
  const placeName = reverseGeo?.city || reverseGeo?.address || coordLabel;
  const address = reverseGeo?.address ?? coordLabel;

  const place = useMemo<Place | null>(
    () =>
      clickedLngLat
        ? createPlace({
            primaryScheme: "coordinate",
            ids: { coordinate: coordinateId(clickedLngLat) },
            name: placeName,
            address,
            coordinates: clickedLngLat,
          })
        : null,
    [address, clickedLngLat, placeName],
  );

  const feedbackToast = (
    <Snackbar
      open={feedback !== null}
      autoHideDuration={3000}
      message={feedback ?? ""}
      onClose={() => setFeedback(null)}
    />
  );

  if (!clickedLngLat || !place) return feedbackToast;

  const handleCoordClick = () => {
    flyTo(clickedLngLat, 15);
    setQuery(coordLabel);
    setIsFocused(false);
    usePlaceStore.getState().setSelectedPlace(place);
    useSidebarStore.getState().openSidebar(PANEL.PLACE);
    setClickedLngLat(null);
  };

  const handleRoute = (endpoint: "origin" | "destination") => {
    routeFromOrTo(endpoint, clickedLngLat, address);
    setClickedLngLat(null);
  };

  const handleShare = async () => {
    const result = await shareLocationLink(place);
    if (result === "unavailable") setFeedback(tm("shareFailed"));
    else if (result === "copied") setFeedback(tm("linkCopied"));
  };

  const handleCopy = async () => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(coordLabel);
      setFeedback(tm("copied"));
    } catch {
      setFeedback(tm("copyFailed"));
    }
  };

  const handleSaveParking = async () => {
    const outcome = await saveAt(clickedLngLat, { address: reverseGeo?.address ?? null });
    setFeedback(outcome === "saved" ? tParking("savedToast") : tParking("locationUnavailable"));
    if (outcome === "saved") setClickedLngLat(null);
  };

  const title = isLoading ? (
    <Skeleton variant="text" width="55%" height={18} />
  ) : (
    <Typography
      variant="body2"
      sx={{
        fontWeight: 600,
        lineHeight: 1.3,
        wordBreak: "break-word",
      }}
    >
      {placeName}
    </Typography>
  );

  if (isMobile) {
    // A dropped pin is where a phone user lands after a long-press, so the
    // card carries what the desktop context menu offers, as a row of actions
    // within thumb reach instead of a menu under the finger.
    return (
      <>
        <Paper
          elevation={3}
          role="region"
          aria-label={tm("ariaLabel", { location: placeName })}
          sx={{
            position: "absolute",
            left: CARD_GAP,
            right: CARD_GAP,
            bottom: phoneCardBottom,
            zIndex: 11,
            borderRadius: 3,
            overflow: "hidden",
          }}
        >
          <Box sx={{ display: "flex", alignItems: "flex-start", gap: 1, px: 2, pt: 1.5 }}>
            <LocationOnIcon sx={{ color: "text.secondary", fontSize: 22, mt: 0.25 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {title}
              {placeName !== coordLabel && (
                <Box
                  component="button"
                  type="button"
                  onClick={handleCoordClick}
                  sx={{
                    color: BRAND,
                    fontWeight: 500,
                    fontSize: 13,
                    border: "none",
                    background: "none",
                    p: 0,
                    mt: 0.25,
                    fontFamily: "inherit",
                    cursor: "pointer",
                  }}
                >
                  {coordLabel}
                </Box>
              )}
            </Box>
            <IconButton
              onClick={() => setClickedLngLat(null)}
              aria-label={tc("close")}
              sx={{ width: 44, height: 44, mr: -1.5, mt: -1 }}
            >
              <CloseIcon />
            </IconButton>
          </Box>
          <Box
            sx={{
              display: "flex",
              gap: 1,
              px: 2,
              pt: 1.5,
              pb: 1.5,
              overflowX: "auto",
              scrollbarWidth: "none",
              "&::-webkit-scrollbar": { display: "none" },
            }}
          >
            <Action
              primary
              icon={<DirectionsIcon />}
              label={tp("directions")}
              onClick={() => handleRoute("destination")}
            />
            <Action
              icon={<TripOriginIcon />}
              label={tm("fromHere")}
              onClick={() => handleRoute("origin")}
            />
            <Action icon={<ShareIcon />} label={tc("share")} onClick={() => void handleShare()} />
            <Action
              icon={<LocalParkingIcon />}
              label={tParking("saveParking")}
              onClick={() => void handleSaveParking()}
            />
            <Action
              icon={<ContentCopyIcon />}
              label={tc("copy")}
              onClick={() => void handleCopy()}
            />
            <Action icon={<InfoOutlinedIcon />} label={tc("details")} onClick={handleCoordClick} />
          </Box>
        </Paper>
        {feedbackToast}
      </>
    );
  }

  return (
    <>
      <Paper
        elevation={3}
        sx={{
          position: "absolute",
          bottom: 24,
          left: "50%",
          transform: "translateX(-50%)",
          zIndex: { xs: 11, sm: 10 },
          width: { xs: "calc(100% - 32px)", sm: 320 },
          maxWidth: 320,
          borderRadius: 2,
          overflow: "visible",
        }}
      >
        <Box sx={{ px: 1.5, pt: 1.25, pb: 1.25 }}>
          {/* Header row: icon + name + close */}
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
            <LocationOnIcon sx={{ color: "text.secondary", fontSize: 18, flexShrink: 0 }} />
            <Box sx={{ flex: 1, minWidth: 0 }}>{title}</Box>
            <IconButton
              size="small"
              onClick={() => setClickedLngLat(null)}
              aria-label={tc("close")}
              sx={{ mr: -0.5 }}
            >
              <CloseIcon sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>

          {/* Divider */}
          <Box sx={{ borderTop: 1, borderColor: "divider", mt: 1, mb: 1 }} />

          {/* Coordinate + action buttons */}
          <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <Box
              component="button"
              type="button"
              onClick={handleCoordClick}
              sx={{
                color: BRAND,
                fontWeight: 500,
                fontSize: 12,
                cursor: "pointer",
                border: "none",
                background: "none",
                p: 0,
                fontFamily: "inherit",
                "&:hover": { textDecoration: "underline" },
              }}
            >
              {coordLabel}
            </Box>
            <IconButton
              size="small"
              onClick={() => handleRoute("destination")}
              aria-label={tp("directions")}
              sx={{
                bgcolor: BRAND,
                color: "white",
                width: 32,
                height: 32,
                borderRadius: "50%",
                "&:hover": { bgcolor: "var(--omx-brand-hover)" },
              }}
            >
              <DirectionsIcon sx={{ fontSize: 18 }} />
            </IconButton>
          </Box>
        </Box>
      </Paper>
      {feedbackToast}
    </>
  );
}

function Action({
  icon,
  label,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <Button
      variant={primary ? "contained" : "outlined"}
      startIcon={icon}
      onClick={onClick}
      sx={{
        flexShrink: 0,
        minHeight: 40,
        borderRadius: 999,
        textTransform: "none",
        whiteSpace: "nowrap",
        ...(primary
          ? { bgcolor: BRAND, "&:hover": { bgcolor: "var(--omx-brand-hover)" } }
          : { color: "text.primary", borderColor: "divider" }),
      }}
    >
      {label}
    </Button>
  );
}
