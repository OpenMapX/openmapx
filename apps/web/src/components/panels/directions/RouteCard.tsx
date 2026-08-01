"use client";

import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import NavigationIcon from "@mui/icons-material/Navigation";
import TwoWheelerIcon from "@mui/icons-material/TwoWheeler";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { Route } from "@openmapx/core";
import {
  bandForDelayRatio,
  estimateDrivingCo2Grams,
  formatDistance,
  formatDuration,
  useDirectionsStore,
  useNavigationStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { formatCo2Emission } from "@/lib/formatCo2";
import { primeSpeechSynthesis } from "@/lib/navigation/useNavigationVoice";
import { BRAND, TRAFFIC_TEXT_COLOR } from "@/lib/theme";
import { requestHeadingPermission } from "@/lib/useHeading";

const GROUND_MODES = new Set<Route["mode"]>(["driving", "walking", "cycling", "motorcycle"]);

/** Absolute floor for showing a traffic delay, in seconds. */
const MIN_TRAFFIC_DELAY_SECONDS = 300;

export function RouteCard({
  route,
  index,
  active,
  onSelect,
  onDetails,
  units,
  alternatives = [],
  provider,
}: {
  route: Route;
  index: number;
  active: boolean;
  onSelect: () => void;
  onDetails: () => void;
  units: "metric" | "imperial";
  /** The other routes, carried into navigation so they can be switched to mid-trip. */
  alternatives?: Route[];
  /** Integration id of the routing provider that served this route, for nav attribution. */
  provider?: string;
}) {
  const t = useTranslations("directions");
  const tc = useTranslations("common");
  const tNav = useTranslations("navigation");
  const locale = useLocale();
  const startGroundNavigation = useNavigationStore((s) => s.startGroundNavigation);
  const waypoints = useDirectionsStore((s) => s.waypoints);

  const handleStart = async () => {
    const coords = waypoints.map((w) => w.coords).filter((c): c is [number, number] => c !== null);
    if (coords.length < 2) return;
    // Unlock TTS inside the user gesture (iOS Safari requirement) before any
    // await hands control back to the event loop.
    primeSpeechSynthesis();
    await requestHeadingPermission();
    startGroundNavigation(route, route.mode, coords, alternatives, provider);
  };

  const dist =
    units === "imperial"
      ? `${(route.distance / 1609.34).toFixed(1)} mi`
      : formatDistance(route.distance);

  const modeIcon =
    route.mode === "driving" ? (
      <DirectionsCarIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    ) : route.mode === "walking" ? (
      <DirectionsWalkIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    ) : route.mode === "motorcycle" ? (
      <TwoWheelerIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    ) : (
      <DirectionsBikeIcon sx={{ fontSize: 22, color: active ? BRAND : "text.disabled" }} />
    );

  // Only worth surfacing when it clears both an absolute floor and a relative
  // one: a 90-second delta on a two-hour drive tells the user nothing, and a
  // large ratio on a very short hop is mostly snapping noise.
  const trafficDelay = (() => {
    const baseline = route.baselineDuration;
    if (baseline === undefined || baseline <= 0) return null;
    const delaySeconds = route.duration - baseline;
    if (delaySeconds < MIN_TRAFFIC_DELAY_SECONDS) return null;
    const band = bandForDelayRatio(delaySeconds / baseline);
    if (!band) return null;
    return { band, delaySeconds, baseline };
  })();

  return (
    <Box
      onClick={onSelect}
      role="button"
      sx={{
        display: "flex",
        gap: 1.5,
        px: 2,
        py: 1.5,
        cursor: "pointer",
        borderLeft: active ? `4px solid ${BRAND}` : "4px solid transparent",
        bgcolor: active ? "rgba(0,123,139,0.04)" : "transparent",
        "&:hover": { bgcolor: active ? "rgba(0,123,139,0.07)" : "action.hover" },
        transition: "background-color 0.15s",
      }}
    >
      <Box sx={{ flexShrink: 0, mt: 0.25 }}>{modeIcon}</Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Box sx={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <Typography
            variant="body2"
            noWrap
            sx={{
              fontWeight: 600,
              color: "text.primary",
              flex: 1,
              mr: 1,
            }}
          >
            {route.summary ?? t("bestRoute")}
          </Typography>
          <Typography
            variant="body2"
            color={active ? BRAND : "text.primary"}
            sx={{
              fontWeight: 600,
              flexShrink: 0,
            }}
          >
            {formatDuration(route.duration)}
          </Typography>
        </Box>
        {trafficDelay && (
          <Typography
            variant="caption"
            data-testid="traffic-delay"
            sx={{
              color: TRAFFIC_TEXT_COLOR[trafficDelay.band],
              display: "block",
              fontWeight: 600,
            }}
          >
            {t("trafficDelay", { delay: formatDuration(trafficDelay.delaySeconds) })}
            {" · "}
            {t("trafficDelayNormally", { baseline: formatDuration(trafficDelay.baseline) })}
          </Typography>
        )}
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {dist}
        </Typography>
        {route.mode === "driving" &&
          (() => {
            const co2 = formatCo2Emission(estimateDrivingCo2Grams(route.distance), locale);
            return co2 ? (
              <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
                {t("co2Estimate", { co2 })}
              </Typography>
            ) : null;
          })()}
        {active && index === 0 && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
              display: "block",
            }}
          >
            {t("fastestRoute")}
          </Typography>
        )}
        {active && (
          <Box sx={{ mt: 0.5, ml: -1.5, display: "flex", alignItems: "center", gap: 0.5 }}>
            <Typography
              component="span"
              variant="caption"
              sx={{
                color: BRAND,
                cursor: "pointer",
                fontWeight: 500,
                px: 1.5,
                py: 0.75,
                borderRadius: 99,
                "&:hover": { bgcolor: `${BRAND}18` },
                transition: "background-color 0.15s",
              }}
              onClick={(e) => {
                e.stopPropagation();
                onDetails();
              }}
            >
              {tc("details")}
            </Typography>
            {GROUND_MODES.has(route.mode) && (
              <Button
                size="small"
                variant="contained"
                startIcon={<NavigationIcon />}
                onClick={(e) => {
                  e.stopPropagation();
                  void handleStart();
                }}
                sx={{
                  bgcolor: BRAND,
                  textTransform: "none",
                  borderRadius: 99,
                  "&:hover": { bgcolor: BRAND },
                }}
              >
                {tNav("start")}
              </Button>
            )}
          </Box>
        )}
      </Box>
    </Box>
  );
}
