"use client";

import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import type { RouteSharePayload } from "@openmapx/core";
import { useCreateShare, useDirectionsStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { ShareLinkCreated } from "@/components/share/ShareLinkCreated";

const SHAREABLE_MODES = new Set(["driving", "walking", "cycling", "motorcycle"]);

/** Reads the current directions inputs and mints a revocable snapshot link. */
export function ShareRouteDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("share");
  const tCommon = useTranslations("common");
  const [mintedToken, setMintedToken] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const createShare = useCreateShare();

  const buildPayload = (): RouteSharePayload | null => {
    const state = useDirectionsStore.getState();
    if (!SHAREABLE_MODES.has(state.mode)) return null;
    const waypoints = state.waypoints
      .filter((w) => w.coords !== null)
      .map((w) => ({
        lat: (w.coords as [number, number])[1],
        lng: (w.coords as [number, number])[0],
        ...(w.label ? { label: w.label.slice(0, 200) } : {}),
      }));
    if (waypoints.length < 2) return null;
    return {
      waypoints,
      mode: state.mode as RouteSharePayload["mode"],
      avoidHighways: state.avoidHighways,
      avoidTolls: state.avoidTolls,
      avoidFerries: state.avoidFerries,
    };
  };

  const handleCreate = () => {
    setError(false);
    const route = buildPayload();
    if (!route) {
      setError(true);
      return;
    }
    createShare.mutate(
      { targetType: "route", route },
      {
        onSuccess: (result) => setMintedToken(result.token),
        onError: () => setError(true),
      },
    );
  };

  const handleClose = () => {
    setMintedToken(null);
    setError(false);
    onClose();
  };

  return (
    <Dialog open={open} onClose={handleClose} fullWidth maxWidth="xs">
      <DialogTitle>{t("shareRoute")}</DialogTitle>
      <DialogContent>
        {mintedToken ? (
          <ShareLinkCreated token={mintedToken} />
        ) : (
          <>
            <Button
              fullWidth
              variant="contained"
              onClick={handleCreate}
              disabled={createShare.isPending}
              sx={{ textTransform: "none" }}
            >
              {t("createLink")}
            </Button>
            {error && (
              <Typography variant="caption" sx={{ color: "error.main", display: "block", mt: 0.5 }}>
                {t("createFailed")}
              </Typography>
            )}
          </>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} sx={{ textTransform: "none" }}>
          {tCommon("close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
