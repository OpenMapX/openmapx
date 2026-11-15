"use client";

import DirectionsIcon from "@mui/icons-material/Directions";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import ShareIcon from "@mui/icons-material/Share";
import Snackbar from "@mui/material/Snackbar";
import Typography from "@mui/material/Typography";
import type { LngLat } from "@openmapx/core";
import { useReverseGeocoding } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { formatMapCoordinates, mapLocationPlace } from "@/components/map/mapLocation";
import { routeFromOrTo, shareLocationLink } from "@/lib/locationActions";
import { LocationCard, LocationCardAction } from "./locationCard";
import { useSaveParking } from "./parking/useSaveParking";

/**
 * The card behind the location dot: where you are, and what to do with it —
 * save it as where the vehicle is parked, share it, or route from it. Laid out
 * like a dropped pin's card, so a point on the map always reads the same way.
 */
export function MyLocationCard({ coords, onClose }: { coords: LngLat; onClose: () => void }) {
  const t = useTranslations("parking");
  const tc = useTranslations("common");
  const tm = useTranslations("mapContextMenu");
  const locale = useLocale();
  const { data: reverseGeo } = useReverseGeocoding(coords, locale);
  const { saveHere, isSaving } = useSaveParking();
  const [toast, setToast] = useState<string | null>(null);

  const label = reverseGeo?.address || formatMapCoordinates(coords);

  const handleSave = async () => {
    const outcome = await saveHere();
    if (outcome !== "saved") {
      setToast(t("locationUnavailable"));
      return;
    }
    onClose();
  };

  const handleShare = async () => {
    const place = mapLocationPlace({ coordinates: coords, poi: null }, reverseGeo);
    const result = await shareLocationLink(place);
    if (result === "unavailable") setToast(tm("shareFailed"));
    else if (result === "copied") setToast(tm("linkCopied"));
  };

  const handleDirections = () => {
    routeFromOrTo("origin", coords, label);
    onClose();
  };

  return (
    <>
      <LocationCard
        ariaLabel={t("yourLocation")}
        icon={<MyLocationIcon sx={{ color: "primary.main" }} />}
        onClose={onClose}
        heading={
          <>
            <Typography sx={{ fontSize: 16, fontWeight: 600, lineHeight: 1.4 }}>
              {t("yourLocation")}
            </Typography>
            <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-word" }}>
              {label}
            </Typography>
          </>
        }
        actions={
          <>
            <LocationCardAction
              primary
              icon={<LocalParkingIcon />}
              label={t("saveParking")}
              disabled={isSaving}
              onClick={() => void handleSave()}
            />
            <LocationCardAction
              icon={<ShareIcon />}
              label={tc("share")}
              onClick={() => void handleShare()}
            />
            <LocationCardAction
              icon={<DirectionsIcon />}
              label={t("directionsFromHere")}
              onClick={handleDirections}
            />
          </>
        }
      />
      <Snackbar
        open={toast !== null}
        message={toast}
        autoHideDuration={3000}
        onClose={() => setToast(null)}
      />
    </>
  );
}
