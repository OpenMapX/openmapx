"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsIcon from "@mui/icons-material/Directions";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import type { LngLat } from "@openmapx/core";
import { PANEL, useDirectionsStore, useReverseGeocoding, useSidebarStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { useSaveParking } from "./parking/useSaveParking";

/**
 * The card behind the location dot. Two actions only: saving where the vehicle
 * is, and routing from here. Anything else already has a home in the context
 * menu or the place panel.
 */
export function MyLocationCard({ coords, onClose }: { coords: LngLat; onClose: () => void }) {
  const t = useTranslations("parking");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { data: reverseGeo } = useReverseGeocoding(coords, locale);
  const { saveHere, isSaving } = useSaveParking();
  const [toast, setToast] = useState<string | null>(null);

  const [lng, lat] = coords;
  const label = reverseGeo?.address || `${lat.toFixed(6)}, ${lng.toFixed(6)}`;

  const handleSave = async () => {
    const outcome = await saveHere();
    if (outcome !== "saved") {
      setToast(t("locationUnavailable"));
      return;
    }
    onClose();
  };

  const handleDirections = () => {
    const directions = useDirectionsStore.getState();
    directions.setWaypoint(0, coords, label);
    directions.open();
    useSidebarStore.getState().closeDetail();
    useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
    onClose();
  };

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
          px: 1.5,
          py: 1.25,
        }}
      >
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.75 }}>
          <MyLocationIcon sx={{ color: "text.secondary", fontSize: 18, flexShrink: 0 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
              {t("yourLocation")}
            </Typography>
            <Typography variant="caption" color="text.secondary" sx={{ wordBreak: "break-word" }}>
              {label}
            </Typography>
          </Box>
          <IconButton size="small" onClick={onClose} aria-label={tc("close")} sx={{ mr: -0.5 }}>
            <CloseIcon sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>

        <Box sx={{ display: "flex", gap: 1, mt: 1.25 }}>
          <Button
            size="small"
            variant="contained"
            startIcon={<LocalParkingIcon />}
            disabled={isSaving}
            onClick={() => void handleSave()}
          >
            {t("saveParking")}
          </Button>
          <Button size="small" startIcon={<DirectionsIcon />} onClick={handleDirections}>
            {t("directionsFromHere")}
          </Button>
        </Box>
      </Paper>
      <Snackbar
        open={toast !== null}
        message={toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
      />
    </>
  );
}
