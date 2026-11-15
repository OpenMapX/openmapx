"use client";

import CloseIcon from "@mui/icons-material/Close";
import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DirectionsIcon from "@mui/icons-material/Directions";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import ShareIcon from "@mui/icons-material/Share";
import StraightenIcon from "@mui/icons-material/Straighten";
import TripOriginIcon from "@mui/icons-material/TripOrigin";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Paper from "@mui/material/Paper";
import Skeleton from "@mui/material/Skeleton";
import Snackbar from "@mui/material/Snackbar";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  PANEL,
  type Place,
  useMapClickStore,
  usePlaceStore,
  useReverseGeocoding,
  useSearchStore,
  useSidebarStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useMemo, useState } from "react";
import {
  describeMapLocation,
  type MapLocation,
  mapLocationCopyRows,
  mapLocationPlace,
} from "@/components/map/mapLocation";
import { findStylePoiAtPoint, getStylePoiLayerIds } from "@/components/map/mapStylePoiTarget";
import { useSaveParking } from "@/components/panels/parking/useSaveParking";
import Menu from "@/components/ui/Menu";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { BRAND } from "@/integration-api/runtime/theme";
import { measureFrom, routeFromOrTo, shareLocationLink } from "@/lib/locationActions";
import { useBackDismiss } from "@/lib/useBackDismiss";
import { LocationCard, LocationCardAction } from "./locationCard";

export function MapClickFloatingCard() {
  const tc = useTranslations("common");
  const tp = useTranslations("place");
  const tm = useTranslations("mapContextMenu");
  const tParking = useTranslations("parking");
  const locale = useLocale();
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  // Touch-first screens wider than a phone (tablets, a phone held sideways)
  // get the same actions: touch has no right-click menu to fall back on.
  const touchFirst = useMediaQuery("(pointer: coarse)");
  const { clickedLngLat, setClickedLngLat } = useMapClickStore();
  const { setQuery, setIsFocused } = useSearchStore();
  const { flyTo, mapRef } = useMap();
  const { saveAt } = useSaveParking();
  const [feedback, setFeedback] = useState<string | null>(null);
  const [copyAnchor, setCopyAnchor] = useState<HTMLElement | null>(null);

  const { data: reverseGeo, isLoading } = useReverseGeocoding(clickedLngLat, locale);
  useBackDismiss(clickedLngLat !== null, () => setClickedLngLat(null));

  // The basemap place under the pin, as the right-click menu finds it, read
  // once when the pin lands: the pin stands where the finger or pointer was.
  const location = useMemo<MapLocation | null>(() => {
    if (!clickedLngLat) return null;
    const map = mapRef?.current;
    const poi = map
      ? findStylePoiAtPoint(
          map,
          map.project(clickedLngLat),
          getStylePoiLayerIds(map),
          INTERACTIVE_LAYER_IDS,
        )
      : null;
    return { coordinates: clickedLngLat, poi };
  }, [clickedLngLat, mapRef]);
  const text = location ? describeMapLocation(location, reverseGeo) : null;
  const coordLabel = text?.coordinates ?? "";
  const placeName = text?.title ?? "";

  const place = useMemo<Place | null>(
    () => (location ? mapLocationPlace(location, reverseGeo) : null),
    [location, reverseGeo],
  );
  const copyRows = useMemo(
    () =>
      location
        ? mapLocationCopyRows(location, reverseGeo, {
            coordinates: tm("coordinates"),
            name: tm("name"),
            address: tm("address"),
          })
        : [],
    [location, reverseGeo, tm],
  );

  const feedbackToast = (
    <Snackbar
      open={feedback !== null}
      autoHideDuration={3000}
      message={feedback ?? ""}
      onClose={() => setFeedback(null)}
    />
  );

  if (!clickedLngLat || !place || !location || !text) return feedbackToast;

  const handleCoordClick = () => {
    flyTo(clickedLngLat, 15);
    setQuery(location.poi ? text.title : coordLabel);
    setIsFocused(false);
    usePlaceStore.getState().setSelectedPlace(place);
    useSidebarStore.getState().openSidebar(PANEL.PLACE);
    setClickedLngLat(null);
  };

  const handleRoute = (endpoint: "origin" | "destination") => {
    routeFromOrTo(endpoint, clickedLngLat, text.routeLabel);
    setClickedLngLat(null);
  };

  const handleShare = async () => {
    const result = await shareLocationLink(place);
    if (result === "unavailable") setFeedback(tm("shareFailed"));
    else if (result === "copied") setFeedback(tm("linkCopied"));
  };

  const copyValue = async (value: string) => {
    setCopyAnchor(null);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard unavailable");
      await navigator.clipboard.writeText(value);
      setFeedback(tm("copied"));
    } catch {
      setFeedback(tm("copyFailed"));
    }
  };

  // One thing to copy goes straight to the clipboard; more offer a choice, as
  // the right-click menu's Copy location does.
  const handleCopy = (button: HTMLElement) => {
    if (copyRows.length > 1) setCopyAnchor(button);
    else void copyValue(copyRows[0]?.value ?? coordLabel);
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

  if (isMobile || touchFirst) {
    // A dropped pin is where a touch user lands after a long-press, so the
    // card carries what the desktop context menu offers, as a row of actions
    // within thumb reach instead of a menu under the finger.
    return (
      <>
        <LocationCard
          ariaLabel={tm("ariaLabel", { location: placeName })}
          icon={<LocationOnIcon />}
          onClose={() => setClickedLngLat(null)}
          heading={
            <>
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
            </>
          }
          actions={
            <>
              <LocationCardAction
                primary
                icon={<DirectionsIcon />}
                label={tp("directions")}
                onClick={() => handleRoute("destination")}
              />
              <LocationCardAction
                icon={<TripOriginIcon />}
                label={tm("fromHere")}
                onClick={() => handleRoute("origin")}
              />
              <LocationCardAction
                icon={<ShareIcon />}
                label={tc("share")}
                onClick={() => void handleShare()}
              />
              <LocationCardAction
                icon={<LocalParkingIcon />}
                label={tParking("saveParking")}
                onClick={() => void handleSaveParking()}
              />
              <LocationCardAction
                icon={<ContentCopyIcon />}
                label={tc("copy")}
                onClick={(event) => handleCopy(event.currentTarget)}
                menuOpen={copyRows.length > 1 ? copyAnchor !== null : undefined}
              />
              <LocationCardAction
                icon={<StraightenIcon />}
                label={tm("measureDistance")}
                onClick={() => {
                  if (!clickedLngLat) return;
                  measureFrom(clickedLngLat);
                  setClickedLngLat(null);
                }}
              />
              <LocationCardAction
                icon={<InfoOutlinedIcon />}
                label={tc("details")}
                onClick={handleCoordClick}
              />
            </>
          }
        />
        <Menu
          anchorEl={copyAnchor}
          open={copyAnchor !== null}
          onClose={() => setCopyAnchor(null)}
          anchorOrigin={{ vertical: "top", horizontal: "left" }}
          transformOrigin={{ vertical: "bottom", horizontal: "left" }}
          slotProps={{ paper: { sx: { minWidth: 240, maxWidth: "calc(100vw - 16px)" } } }}
        >
          {copyRows.map((row) => (
            <MenuItem
              key={row.value}
              onClick={() => void copyValue(row.value)}
              sx={{ minHeight: "48px !important" }}
            >
              <ListItemText primary={row.label} secondary={row.value} />
            </MenuItem>
          ))}
        </Menu>
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
