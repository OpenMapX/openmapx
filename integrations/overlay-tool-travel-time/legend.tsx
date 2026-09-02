"use client";

import CloseIcon from "@mui/icons-material/Close";
import DirectionsBikeIcon from "@mui/icons-material/DirectionsBike";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Chip from "@mui/material/Chip";
import CircularProgress from "@mui/material/CircularProgress";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import {
  type LngLat,
  TRANSIT_WALK_PROFILE,
  type TransitIsochroneRequest,
  type TransitReachabilitySurfaceRequest,
  useIsochrone,
  useTransitIsochrone,
  useTransitReachability,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useMemo } from "react";
import { exportTransitIsochrone, transitIsochroneFilename } from "./export-geojson";
import {
  resolveTravelTimeBackend,
  TRAVEL_TIME_PRESETS,
  type TransitSurfaceKind,
  type TravelTimeMode,
  useTravelTimeStore,
} from "./store";

function formatPresetLabel(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m}`;
}

export function TravelTimeToolbar() {
  const t = useTranslations("travelTime");
  const isActive = useTravelTimeStore((s) => s.isActive);
  const origin = useTravelTimeStore((s) => s.origin);
  const mode = useTravelTimeStore((s) => s.mode);
  const selectedMinutes = useTravelTimeStore((s) => s.selectedMinutes);
  const anchored = useTravelTimeStore((s) => s.anchored);
  const onlyWithinReach = useTravelTimeStore((s) => s.onlyWithinReach);
  const queryTime = useTravelTimeStore((s) => s.queryTime);
  const showTransitStops = useTravelTimeStore((s) => s.showTransitStops);
  const transitFieldUnsupported = useTravelTimeStore((s) => s.transitFieldUnsupported);
  const transitFilterState = useTravelTimeStore((s) => s.transitFilterState);
  const transitSurfaceKind = useTravelTimeStore((s) => s.transitSurfaceKind);
  const transitPolygonBbox = useTravelTimeStore((s) => s.transitPolygonBbox);
  const setTransitSurfaceKind = useTravelTimeStore((s) => s.setTransitSurfaceKind);
  const requestTransitPolygons = useTravelTimeStore((s) => s.requestTransitPolygons);
  const setMode = useTravelTimeStore((s) => s.setMode);
  const toggleMinutes = useTravelTimeStore((s) => s.toggleMinutes);
  const setOrigin = useTravelTimeStore((s) => s.setOrigin);
  const setOnlyWithinReach = useTravelTimeStore((s) => s.setOnlyWithinReach);
  const setShowTransitStops = useTravelTimeStore((s) => s.setShowTransitStops);
  const deactivate = useTravelTimeStore((s) => s.deactivate);

  const backend = resolveTravelTimeBackend(mode);
  const isTransit = backend.kind === "transit-reachability";
  const { isFetching: isochroneFetching } = useIsochrone({
    origin,
    mode: backend.kind === "street-isochrone" ? backend.mode : "walking",
    contourMinutes: selectedMinutes,
    enabled: isActive && !isTransit,
  });
  const transitRequest = useMemo<TransitReachabilitySurfaceRequest | null>(() => {
    if (!origin || !queryTime || !isTransit || selectedMinutes.length === 0) return null;
    return {
      origin: { lng: origin[0], lat: origin[1] },
      queryTime,
      direction: "depart-at",
      thresholdsMinutes: [Math.max(...selectedMinutes)],
      walkProfileId: TRANSIT_WALK_PROFILE.id,
    };
  }, [isTransit, origin, queryTime, selectedMinutes]);
  const { data: transitSurface, isFetching: reachFetching } = useTransitReachability(
    transitRequest,
    isActive && isTransit,
  );
  const showPolygons = isTransit && transitSurfaceKind === "polygons";
  // Mirrors the map layer's request so react-query serves both from one fetch.
  const isochroneRequest = useMemo<TransitIsochroneRequest | null>(() => {
    if (!origin || !queryTime || !showPolygons || !transitPolygonBbox) return null;
    if (selectedMinutes.length === 0) return null;
    return {
      origin: { lng: origin[0], lat: origin[1] },
      queryTime,
      direction: "depart-at",
      thresholdsMinutes: [...selectedMinutes].sort((a, b) => a - b),
      walkProfileId: TRANSIT_WALK_PROFILE.id,
      bbox: transitPolygonBbox,
    };
  }, [origin, queryTime, selectedMinutes, showPolygons, transitPolygonBbox]);
  const {
    data: transitIsochrone,
    isFetching: isochroneSampling,
    error: isochroneError,
  } = useTransitIsochrone(isochroneRequest, isActive && showPolygons);

  const isFetching = isTransit ? reachFetching : isochroneFetching;
  const polygonsSupported = transitSurface?.capabilities.exportableIsochrones === true;

  if (!isActive) return null;

  const presets = TRAVEL_TIME_PRESETS[mode];

  const handleMyLocation = () => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const lngLat: LngLat = [pos.coords.longitude, pos.coords.latitude];
        setOrigin(lngLat);
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10_000 },
    );
  };

  return (
    <Paper
      elevation={3}
      sx={{
        px: 1.5,
        py: 1,
        borderRadius: "12px",
        display: "flex",
        flexDirection: "column",
        gap: 1,
        maxWidth: { xs: "calc(100vw - 24px)", sm: 480 },
      }}
    >
      {/* Top row: mode + my location + status + close */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <ToggleButtonGroup
          value={mode}
          exclusive
          size="small"
          onChange={(_, v: TravelTimeMode | null) => {
            if (v) setMode(v);
          }}
          sx={{ "& .MuiToggleButton-root": { px: 1, py: 0.5 } }}
        >
          <ToggleButton value="driving" aria-label={t("driving")}>
            <Tooltip title={t("driving")}>
              <DirectionsCarIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="walking" aria-label={t("walking")}>
            <Tooltip title={t("walking")}>
              <DirectionsWalkIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="cycling" aria-label={t("cycling")}>
            <Tooltip title={t("cycling")}>
              <DirectionsBikeIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
          <ToggleButton value="transit" aria-label={t("transit")}>
            <Tooltip title={t("transit")}>
              <DirectionsTransitIcon sx={{ fontSize: 20 }} />
            </Tooltip>
          </ToggleButton>
        </ToggleButtonGroup>

        <Tooltip title={t("myLocation")}>
          <IconButton size="small" onClick={handleMyLocation} aria-label={t("myLocation")}>
            <MyLocationIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>

        <Box sx={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center" }}>
          {isFetching ? (
            <CircularProgress size={16} />
          ) : (
            <Typography sx={{ fontSize: 12, color: "text.secondary", textAlign: "center" }}>
              {origin ? t("dragToMove") : t("clickToPlace")}
            </Typography>
          )}
        </Box>

        <Tooltip title={t("close")}>
          <IconButton size="small" onClick={deactivate} aria-label={t("close")}>
            <CloseIcon sx={{ fontSize: 20 }} />
          </IconButton>
        </Tooltip>
      </Box>

      <Divider />

      {/* Bottom row: time preset chips */}
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, justifyContent: "center" }}>
        {presets.map((minutes) => {
          const selected = selectedMinutes.includes(minutes);
          return (
            <Chip
              key={minutes}
              label={formatPresetLabel(minutes)}
              size="small"
              variant={selected ? "filled" : "outlined"}
              color={selected ? "primary" : "default"}
              onClick={() => toggleMinutes(minutes)}
              sx={{
                fontWeight: selected ? 600 : 400,
                fontSize: 12,
              }}
            />
          );
        })}
      </Box>

      {isTransit && (
        <>
          <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
            {t("estimatedSurface", {
              speed: TRANSIT_WALK_PROFILE.speedMetresPerSecond,
              minutes: TRANSIT_WALK_PROFILE.egressSeconds / 60,
            })}
          </Typography>
          {transitFieldUnsupported && !showPolygons && (
            <Typography role="status" sx={{ fontSize: 11, color: "warning.main" }}>
              {t("fieldFallback")}
            </Typography>
          )}

          {polygonsSupported && (
            <>
              <ToggleButtonGroup
                value={transitSurfaceKind}
                exclusive
                size="small"
                onChange={(_, v: TransitSurfaceKind | null) => {
                  if (v) setTransitSurfaceKind(v);
                }}
                sx={{ alignSelf: "flex-start", "& .MuiToggleButton-root": { px: 1, py: 0.25 } }}
              >
                <ToggleButton value="estimated" sx={{ fontSize: 11, textTransform: "none" }}>
                  {t("surfaceKindEstimated")}
                </ToggleButton>
                <ToggleButton value="polygons" sx={{ fontSize: 11, textTransform: "none" }}>
                  {t("surfaceKindPolygons")}
                </ToggleButton>
              </ToggleButtonGroup>

              {showPolygons && (
                <>
                  <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
                    {t("polygonAccuracy")}
                  </Typography>
                  <Box sx={{ display: "flex", gap: 1, alignItems: "center", flexWrap: "wrap" }}>
                    <Button
                      size="small"
                      variant="outlined"
                      disabled={isochroneSampling || !origin}
                      onClick={requestTransitPolygons}
                      sx={{ fontSize: 11, textTransform: "none" }}
                    >
                      {isochroneSampling ? t("generatingPolygons") : t("generatePolygons")}
                    </Button>
                    {transitIsochrone && !isochroneSampling && (
                      <Button
                        size="small"
                        variant="text"
                        onClick={() =>
                          exportTransitIsochrone(
                            transitIsochrone.featureCollection,
                            transitIsochroneFilename(transitIsochrone.queryTime),
                          )
                        }
                        sx={{ fontSize: 11, textTransform: "none" }}
                      >
                        {t("downloadGeoJson")}
                      </Button>
                    )}
                  </Box>
                  <Typography aria-live="polite" sx={{ fontSize: 11, color: "text.secondary" }}>
                    {isochroneSampling
                      ? t("polygonStatusSampling")
                      : isochroneError
                        ? t("polygonFailed")
                        : transitIsochrone
                          ? t("polygonStatusReady", {
                              samples: transitIsochrone.sampling.sampleCount,
                              metres: Math.round(transitIsochrone.sampling.resolutionMetres),
                            })
                          : t("polygonStatusIdle")}
                  </Typography>
                  {transitIsochrone?.sampling.clippedToBbox && (
                    <Typography sx={{ fontSize: 11, color: "warning.main" }}>
                      {t("polygonClipped")}
                    </Typography>
                  )}
                </>
              )}
            </>
          )}
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={showTransitStops}
                onChange={(e) => setShowTransitStops(e.target.checked)}
              />
            }
            label={<Typography sx={{ fontSize: 12 }}>{t("showTransitStops")}</Typography>}
            sx={{ m: 0, alignSelf: "flex-start" }}
          />
        </>
      )}

      {anchored && (
        <>
          <Divider />
          <FormControlLabel
            control={
              <Switch
                size="small"
                checked={onlyWithinReach}
                disabled={
                  isTransit &&
                  transitSurface !== undefined &&
                  !transitSurface.capabilities.exactPointChecks
                }
                onChange={(e) => setOnlyWithinReach(e.target.checked)}
              />
            }
            label={<Typography sx={{ fontSize: 12 }}>{t("onlyWithinReach")}</Typography>}
            sx={{ m: 0, alignSelf: "flex-start" }}
          />
          {isTransit && transitSurface && !transitSurface.capabilities.exactPointChecks && (
            <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
              {t("exactFilterUnavailable")}
            </Typography>
          )}
          {isTransit && onlyWithinReach && (
            <Typography aria-live="polite" sx={{ fontSize: 11, color: "text.secondary" }}>
              {t(`filterState.${transitFilterState}`)}
            </Typography>
          )}
        </>
      )}
    </Paper>
  );
}
