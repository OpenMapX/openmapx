"use client";

import Button from "@mui/material/Button";
import Paper from "@mui/material/Paper";
import Stack from "@mui/material/Stack";
import Typography from "@mui/material/Typography";
import type { NavigationConnectivity } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { OfflineRouteCoverage } from "@/lib/navigation/offlineRouteCoverage";

export interface OfflineNavigationBannerProps {
  connectivity: NavigationConnectivity;
  rerouteUnavailable: boolean;
  liveDataUnavailable: boolean;
  coverage: OfflineRouteCoverage;
  offRoute?: boolean;
  rerouting?: boolean;
  onRetryReroute: () => void;
}

export function OfflineNavigationBanner({
  connectivity,
  rerouteUnavailable,
  liveDataUnavailable,
  coverage,
  offRoute = false,
  rerouting = false,
  onRetryReroute,
}: OfflineNavigationBannerProps) {
  const t = useTranslations("navigation");
  const offline = connectivity === "offline";
  const mapMessage =
    offline && coverage.kind === "not-downloaded"
      ? t("offlineMapNotDownloaded")
      : offline && coverage.kind === "route-line-only"
        ? t("offlineRouteLineOnly")
        : null;
  const visible = offline || rerouteUnavailable || liveDataUnavailable || !!mapMessage;
  if (!visible) return null;

  return (
    <Paper
      data-testid="offline-navigation-banner"
      role="status"
      aria-live="polite"
      elevation={2}
      sx={{ alignSelf: "flex-start", px: 1.5, py: 1, maxWidth: 420 }}
    >
      <Stack spacing={0.5}>
        {offline && <Typography variant="body2">{t("offlineRouteContinuation")}</Typography>}
        {rerouteUnavailable && (
          <Typography variant="body2">{t("offlineRerouteUnavailable")}</Typography>
        )}
        {liveDataUnavailable && (
          <Typography variant="caption" color="text.secondary">
            {t("offlineLiveDataUnavailable")}
          </Typography>
        )}
        {mapMessage && (
          <Typography variant="caption" color="text.secondary">
            {mapMessage}
          </Typography>
        )}
        {connectivity === "online" && rerouteUnavailable && offRoute && (
          <Button
            size="small"
            variant="outlined"
            disabled={rerouting}
            onClick={onRetryReroute}
            data-testid="offline-navigation-retry-reroute"
            sx={{ alignSelf: "flex-start" }}
          >
            {t("offlineRerouteRetry")}
          </Button>
        )}
      </Stack>
    </Paper>
  );
}
