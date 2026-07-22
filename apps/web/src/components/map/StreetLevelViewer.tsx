"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useDirectionsStore, useStreetLevelStore } from "@openmapx/core";
import dynamic from "next/dynamic";
import { useTranslations } from "next-intl";
import { useEffect } from "react";
import { useStreetLevelProviders } from "./street-level-imagery/useStreetLevelProviders";

const StreetLevelViewerInner = dynamic(
  () => import("./street-level-imagery/StreetLevelViewerInner"),
  {
    ssr: false,
  },
);

function StreetLevelLoadGate() {
  const t = useTranslations("streetLevel");
  const tc = useTranslations("common");
  const pendingImage = useStreetLevelStore((s) => s.pendingImage);
  const confirmPendingImageLoad = useStreetLevelStore((s) => s.confirmPendingImageLoad);
  const cancelPendingImageLoad = useStreetLevelStore((s) => s.cancelPendingImageLoad);
  const { providers, isLoading } = useStreetLevelProviders();

  const provider = providers.find((p) => p.id === pendingImage?.providerId);

  // A provider served entirely through our own proxy exposes nothing to a
  // third party, so it needs no notice.
  useEffect(() => {
    if (provider && provider.endUserExposure === "server-only") {
      confirmPendingImageLoad();
    }
  }, [provider, confirmPendingImageLoad]);

  // A deep link can name a provider the operator has disabled. Cancel rather
  // than leaving an empty viewer behind with no way to understand why.
  useEffect(() => {
    if (pendingImage && !isLoading && providers.length > 0 && !provider) {
      cancelPendingImageLoad();
    }
  }, [pendingImage, isLoading, providers.length, provider, cancelPendingImageLoad]);

  // Hold the dialog back until we know which provider we are asking about,
  // otherwise the copy interpolates an empty provider name.
  const open = pendingImage !== null && provider !== undefined;
  const providerName = provider?.name ?? "";

  return (
    <Dialog
      open={open}
      onClose={cancelPendingImageLoad}
      aria-labelledby="street-level-imagery-load-gate-title"
      maxWidth="xs"
      fullWidth
    >
      <DialogTitle id="street-level-imagery-load-gate-title">
        {t("providerNoticeTitle", { provider: providerName })}
      </DialogTitle>
      <DialogContent>
        <Typography variant="body2" sx={{ mb: 1.5 }}>
          {t("providerNoticeBody", { provider: providerName })}
        </Typography>
        <Typography variant="body2" sx={{ color: "text.secondary", mb: 1.5 }}>
          {t("providerNoticeData", { provider: providerName })}
        </Typography>
        {provider?.privacyUrl && (
          <Link href={provider.privacyUrl} target="_blank" rel="noopener noreferrer">
            {t("providerPrivacyLink")}
          </Link>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={cancelPendingImageLoad} color="inherit">
          {tc("cancel")}
        </Button>
        <Button onClick={confirmPendingImageLoad} variant="contained">
          {t("loadProviderViewer")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export function StreetLevelViewer() {
  const activeImage = useStreetLevelStore((s) => s.activeImage);
  const closeDirections = useDirectionsStore((s) => s.close);

  // Ensure directions panel is closed whenever the viewer opens so the
  // SearchBar (which returns null while directionsOpen=true) is always visible.
  useEffect(() => {
    if (activeImage !== null) closeDirections();
  }, [activeImage, closeDirections]);

  if (!activeImage) return <StreetLevelLoadGate />;
  return (
    <>
      <StreetLevelLoadGate />
      <StreetLevelViewerInner />
    </>
  );
}
