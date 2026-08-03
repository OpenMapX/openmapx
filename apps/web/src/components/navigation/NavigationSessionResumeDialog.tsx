"use client";

import Alert from "@mui/material/Alert";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Typography from "@mui/material/Typography";
import { formatMeasurementDistance, type NavigationSessionSnapshot } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { OfflineRouteCoverage } from "@/lib/navigation/offlineRouteCoverage";

interface Props {
  snapshot: NavigationSessionSnapshot;
  coverage: OfflineRouteCoverage;
  onResume: () => void;
  onDiscard: () => void;
}

export function NavigationSessionResumeDialog({ snapshot, coverage, onResume, onDiscard }: Props) {
  const t = useTranslations("navigation");
  const coverageText =
    coverage.kind === "covered"
      ? t("offlineCoverageCovered")
      : coverage.kind === "route-line-only"
        ? t("offlineRouteLineOnly")
        : t("offlineMapNotDownloaded");

  return (
    <Dialog open maxWidth="xs" fullWidth data-testid="navigation-session-resume-dialog">
      <DialogTitle>{t("offlineResumeTitle")}</DialogTitle>
      <DialogContent dividers>
        <Typography variant="body1" sx={{ mb: 1 }}>
          {snapshot.route.summary ?? t("offlineRouteContinuation")}
        </Typography>
        <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
          {formatMeasurementDistance(snapshot.route.distance, "metric")} · {coverageText}
        </Typography>
        <Alert severity="info">{t("offlineResumeBody")}</Alert>
      </DialogContent>
      <DialogActions>
        <Button onClick={onDiscard} data-testid="navigation-session-discard">
          {t("offlineDiscardRoute")}
        </Button>
        <Button onClick={onResume} variant="contained" data-testid="navigation-session-resume">
          {t("offlineResumeRoute")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
