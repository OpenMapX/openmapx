"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import type { WildfireSourceId, WildfireSourceStatus } from "./store";
import { useWildfireStore } from "./store";

const DAY_RANGES = [1, 2, 3] as const;

const RECENCY_LEGEND = [
  { labelKey: "lessThan1h", color: "#ef4444" },
  { labelKey: "1to6h", color: "#f97316" },
  { labelKey: "6to12h", color: "#fb923c" },
  { labelKey: "12to24h", color: "#fbbf24" },
  { labelKey: "1to2d", color: "#fcd34d" },
  { labelKey: "2to3d", color: "#fde68a" },
] as const;

const FRP_SIZES = [
  { label: "< 10", size: 5 },
  { label: "50", size: 10 },
  { label: "500+", size: 20 },
] as const;

interface SourceSummary {
  loading: boolean;
  errorCount: number;
  stale: boolean;
  lastUpdated: number | null;
}

export function summarizeWildfireSources(
  statuses: Record<WildfireSourceId, WildfireSourceStatus>,
  enabled: readonly WildfireSourceId[],
): SourceSummary {
  const selected = enabled.map((id) => statuses[id]);
  const fetched = selected
    .map((status) => status.fetchedAt)
    .filter((value): value is number => value !== null);
  return {
    loading: selected.some((status) => status.loading),
    errorCount: selected.filter((status) => status.error !== null).length,
    stale: selected.some((status) => status.stale),
    lastUpdated: fetched.length > 0 ? Math.max(...fetched) : null,
  };
}

export function WildfireLegend() {
  const t = useTranslations("wildfires");
  const panelOpen = useWildfireStore((s) => s.panelOpen);
  const layerVisible = useWildfireStore((s) => s.layerVisible);
  const dayRange = useWildfireStore((s) => s.dayRange);
  const source = useWildfireStore((s) => s.source);
  const showHotspots = useWildfireStore((s) => s.showHotspots);
  const showNifcPerimeters = useWildfireStore((s) => s.showNifcPerimeters);
  const showEffisBurnedAreas = useWildfireStore((s) => s.showEffisBurnedAreas);
  const showNoaaSmoke = useWildfireStore((s) => s.showNoaaSmoke);
  const showHeatmap = useWildfireStore((s) => s.showHeatmap);
  const statuses = useWildfireStore((s) => s.statuses);
  const setLayerVisible = useOverlayVisibilitySetter("wildfires");
  const setDayRange = useWildfireStore((s) => s.setDayRange);
  const setSource = useWildfireStore((s) => s.setSource);
  const setShowHotspots = useWildfireStore((s) => s.setShowHotspots);
  const setShowNifcPerimeters = useWildfireStore((s) => s.setShowNifcPerimeters);
  const setShowEffisBurnedAreas = useWildfireStore((s) => s.setShowEffisBurnedAreas);
  const setShowNoaaSmoke = useWildfireStore((s) => s.setShowNoaaSmoke);
  const setShowHeatmap = useWildfireStore((s) => s.setShowHeatmap);
  const enabledSources: WildfireSourceId[] = [];
  if (showHotspots) enabledSources.push("firms");
  if (showNifcPerimeters) enabledSources.push("nifc");
  if (showEffisBurnedAreas) enabledSources.push("effis");
  if (showNoaaSmoke) enabledSources.push("noaa-hms");
  const summary = summarizeWildfireSources(statuses, enabledSources);

  const sourceToggles = [
    {
      id: "hotspots",
      label: t("hotspotDetections"),
      checked: showHotspots,
      setChecked: setShowHotspots,
    },
    {
      id: "nifc",
      label: t("nifcPerimeters"),
      checked: showNifcPerimeters,
      setChecked: setShowNifcPerimeters,
    },
    {
      id: "effis",
      label: t("effisBurnedAreas"),
      checked: showEffisBurnedAreas,
      setChecked: setShowEffisBurnedAreas,
    },
    {
      id: "noaa",
      label: t("observedSmoke"),
      checked: showNoaaSmoke,
      setChecked: setShowNoaaSmoke,
    },
  ] as const;

  return (
    <OverlayLegend
      title={t("wildfires")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={layerVisible && summary.loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: "calc(100vw - 24px)" }}
      headerSx={{ mb: 0.75 }}
    >
      <Box sx={{ display: "flex", gap: 0.25, flexWrap: "wrap", mb: showHotspots ? 0.75 : 0 }}>
        {sourceToggles.map(({ id, label, checked, setChecked }) => (
          <FormControlLabel
            key={id}
            label={<Typography sx={{ fontSize: 10.5 }}>{label}</Typography>}
            control={
              <Switch
                size="small"
                checked={checked}
                onChange={(event) => setChecked(event.target.checked)}
              />
            }
            sx={{ m: 0, mr: 1 }}
          />
        ))}
      </Box>

      {showHotspots && (
        <>
          <Box sx={{ display: "flex", gap: 1.5, alignItems: "flex-start", flexWrap: "wrap" }}>
            <Box>
              <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
                {t("dayRange")}
              </Typography>
              <ToggleButtonGroup
                value={dayRange}
                exclusive
                onChange={(_, val) => val !== null && setDayRange(val)}
                size="small"
                sx={{ height: 26 }}
              >
                {DAY_RANGES.map((days) => (
                  <ToggleButton
                    key={days}
                    value={days}
                    sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
                  >
                    {t("nDays", { count: days })}
                  </ToggleButton>
                ))}
              </ToggleButtonGroup>
            </Box>

            <Box>
              <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.3 }}>
                {t("sensor")}
              </Typography>
              <ToggleButtonGroup
                value={source}
                exclusive
                onChange={(_, val) => val && setSource(val)}
                size="small"
                sx={{ height: 26 }}
              >
                <ToggleButton
                  value="VIIRS_SNPP_NRT"
                  sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
                >
                  VIIRS 375m
                </ToggleButton>
                <ToggleButton
                  value="MODIS_NRT"
                  sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
                >
                  MODIS 1km
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            <Box sx={{ display: "flex", alignItems: "center", pt: 1.5 }}>
              <FormControlLabel
                label={<Typography sx={{ fontSize: 10.5 }}>{t("heatmap")}</Typography>}
                control={
                  <Switch
                    size="small"
                    checked={showHeatmap}
                    onChange={(event) => setShowHeatmap(event.target.checked)}
                    sx={{ mr: 0.5 }}
                  />
                }
                sx={{ m: 0 }}
              />
            </Box>
          </Box>
          <Box sx={{ display: "flex", gap: 2, mt: 0.75, alignItems: "flex-start" }}>
            <Box>
              <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
                {t("recencyScale")}
              </Typography>
              <Box sx={{ display: "flex", gap: 0.75 }}>
                {RECENCY_LEGEND.map((entry) => (
                  <Box
                    key={entry.labelKey}
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 0.25,
                    }}
                  >
                    <Box
                      sx={{ width: 20, height: 10, borderRadius: "2px", bgcolor: entry.color }}
                    />
                    <Typography sx={{ fontSize: 9, lineHeight: 1.2, whiteSpace: "nowrap" }}>
                      {t(entry.labelKey)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>

            <Box>
              <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
                {t("frpSize")}
              </Typography>
              <Box sx={{ display: "flex", gap: 1, alignItems: "flex-end" }}>
                {FRP_SIZES.map((entry) => (
                  <Box
                    key={entry.label}
                    sx={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "center",
                      gap: 0.25,
                    }}
                  >
                    <Box
                      sx={{
                        width: entry.size,
                        height: entry.size,
                        borderRadius: "50%",
                        bgcolor: "#ef4444",
                        border: "1.5px solid var(--omx-overlay-bg)",
                        boxShadow: "0 0 0 0.5px var(--omx-shadow-soft)",
                      }}
                    />
                    <Typography sx={{ fontSize: 9, lineHeight: 1.2 }}>{entry.label}</Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        </>
      )}

      <Box
        role="status"
        data-last-updated={summary.lastUpdated ?? undefined}
        data-error-count={summary.errorCount}
        sx={{ display: "grid", gap: 0.15, mt: 0.75 }}
      >
        {summary.errorCount > 0 && (
          <Typography sx={{ fontSize: 10.5, color: "error.main" }}>
            {t("sourceUnavailable", { count: summary.errorCount })}
          </Typography>
        )}
        {summary.stale && (
          <Typography sx={{ fontSize: 10.5, color: "warning.main" }}>{t("staleData")}</Typography>
        )}
        {summary.lastUpdated !== null && (
          <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
            {t("lastUpdated", {
              time: new Date(summary.lastUpdated).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              }),
            })}
          </Typography>
        )}
      </Box>
    </OverlayLegend>
  );
}
