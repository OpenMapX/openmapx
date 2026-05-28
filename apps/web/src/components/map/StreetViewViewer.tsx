"use client";

import { useStreetViewStore } from "@integrations/street-view-mapillary/store";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useDirectionsStore } from "@openmapx/core";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect } from "react";

const StreetViewViewerInner = dynamic(() => import("./StreetViewViewerInner"), { ssr: false });
const MAPILLARY_PRIVACY_URL = "https://www.mapillary.com/privacy";

function StreetViewLoadGate() {
  const t = useTranslations("streetView");
  const tc = useTranslations("common");
  const pendingImageId = useStreetViewStore((s) => s.pendingImageId);
  const confirmPendingImageLoad = useStreetViewStore((s) => s.confirmPendingImageLoad);
  const cancelPendingImageLoad = useStreetViewStore((s) => s.cancelPendingImageLoad);

  return (
    <Dialog
      open={pendingImageId !== null}
      onClose={cancelPendingImageLoad}
      aria-labelledby="mapillary-load-gate-title"
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id="mapillary-load-gate-title">{t("mapillaryNoticeTitle")}</DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {t("mapillaryNoticeBody")}
        </Typography>
        <Typography
          variant="body2"
          sx={{
            color: "text.secondary",
            mb: 1.5,
          }}
        >
          {t("mapillaryNoticeData")}
        </Typography>
        <Link href={MAPILLARY_PRIVACY_URL} target="_blank" rel="noopener noreferrer">
          {t("mapillaryPrivacyLink")}
        </Link>
      </DialogContent>
      <DialogActions>
        <Button onClick={cancelPendingImageLoad} color="inherit">
          {tc("cancel")}
        </Button>
        <Button onClick={confirmPendingImageLoad} variant="contained">
          {t("loadMapillaryViewer")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function StreetViewViewer() {
  const activeImageId = useStreetViewStore((s) => s.activeImageId);
  const closeDirections = useDirectionsStore((s) => s.close);

  // Ensure directions panel is closed whenever the viewer opens so the
  // SearchBar (which returns null while directionsOpen=true) is always visible.
  useEffect(() => {
    if (activeImageId !== null) closeDirections();
  }, [activeImageId, closeDirections]);

  if (!activeImageId) return <StreetViewLoadGate />;
  return (
    <>
      <StreetViewLoadGate />
      <StreetViewViewerInner />
    </>
  );
}
