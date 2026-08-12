"use client";

import Box from "@mui/material/Box";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import { alpha } from "@mui/material/styles";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useMapStore, useOverlayVisibilitySetter } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import {
  EFFIS_BURNED_AREA_STYLE,
  NIFC_PERIMETER_STYLE,
  NOAA_SMOKE_OPACITY,
  NOAA_SMOKE_STYLE,
} from "./presentation";
import type { WildfireSourceStatus } from "./store";
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

interface SourceRowProps {
  id: string;
  title: string;
  coverage: string;
  switchLabel: string;
  checked: boolean;
  onChange(checked: boolean): void;
  status: WildfireSourceStatus;
  zoomGated?: boolean;
  children?: ReactNode;
}

function SourceRow({
  id,
  title,
  coverage,
  switchLabel,
  checked,
  onChange,
  status,
  zoomGated = false,
  children,
}: SourceRowProps) {
  return (
    <Box
      component="section"
      data-testid={`wildfire-source-${id}`}
      sx={{ borderTop: "1px solid", borderColor: "divider", pt: 0.8, mt: 0.8 }}
    >
      <FormControlLabel
        labelPlacement="start"
        label={
          <Box>
            <Typography component="h3" sx={{ fontSize: 11.5, fontWeight: 650, lineHeight: 1.25 }}>
              {title}
            </Typography>
            <Typography sx={{ fontSize: 9.5, color: "text.secondary", lineHeight: 1.3 }}>
              {coverage}
            </Typography>
          </Box>
        }
        control={
          <Switch
            size="small"
            checked={checked}
            onChange={(event) => onChange(event.target.checked)}
            slotProps={{ input: { "aria-label": switchLabel } }}
          />
        }
        sx={{
          alignItems: "center",
          justifyContent: "space-between",
          gap: 1,
          m: 0,
          width: "100%",
          "& .MuiFormControlLabel-label": { flex: 1 },
        }}
      />
      <SourceStatus enabled={checked} status={status} zoomGated={zoomGated} />
      {children}
    </Box>
  );
}

function SourceStatus({
  enabled,
  status,
  zoomGated,
}: {
  enabled: boolean;
  status: WildfireSourceStatus;
  zoomGated: boolean;
}) {
  const t = useTranslations("wildfires");
  const locale = useLocale();
  if (!enabled) return null;

  if (zoomGated) {
    return (
      <Typography role="status" aria-live="polite" sx={{ fontSize: 10, color: "text.secondary" }}>
        {t("zoomInToLoadPolygons")}
      </Typography>
    );
  }

  const formattedTime =
    status.fetchedAt !== null && Number.isFinite(status.fetchedAt)
      ? new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(
          status.fetchedAt,
        )
      : null;
  const hasStatus =
    status.loading ||
    status.error !== null ||
    status.featureCount !== null ||
    formattedTime !== null ||
    status.stale ||
    status.truncated;
  if (!hasStatus) return null;

  return (
    <Box role="status" aria-live="polite" sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
      {status.loading ? <StatusText>{t("loading")}</StatusText> : null}
      {status.error !== null ? (
        <StatusText color="error.main">{t("sourceUnavailable")}</StatusText>
      ) : null}
      {status.featureCount === 0 ? (
        <StatusText>{t("noFeaturesInView")}</StatusText>
      ) : status.featureCount !== null ? (
        <StatusText>{t("featureCount", { count: status.featureCount })}</StatusText>
      ) : null}
      {status.stale ? (
        <StatusText color="warning.main">
          {formattedTime ? t("staleTime", { time: formattedTime }) : t("staleData")}
        </StatusText>
      ) : formattedTime ? (
        <StatusText>{t("updatedTime", { time: formattedTime })}</StatusText>
      ) : null}
      {status.truncated ? (
        <StatusText color="warning.main">{t("truncatedForView")}</StatusText>
      ) : null}
    </Box>
  );
}

function StatusText({
  children,
  color = "text.secondary",
}: {
  children: ReactNode;
  color?: string;
}) {
  return (
    <Typography component="span" sx={{ fontSize: 10, color, lineHeight: 1.35 }}>
      {children}
    </Typography>
  );
}

interface SwatchProps {
  label: string;
  fillColor: string;
  fillOpacity?: number;
  lineColor?: string;
  dashed?: boolean;
}

function Swatch({
  label,
  fillColor,
  fillOpacity = 1,
  lineColor = fillColor,
  dashed = false,
}: SwatchProps) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.45 }}>
      <Box
        component="span"
        role="img"
        aria-label={label}
        data-fill-opacity={fillOpacity}
        data-line-style={dashed ? "dashed" : "solid"}
        sx={{
          width: 22,
          height: 10,
          borderRadius: "2px",
          bgcolor: alpha(fillColor, fillOpacity),
          border: `1.5px ${dashed ? "dashed" : "solid"} ${lineColor}`,
          boxSizing: "border-box",
        }}
      />
      <Typography sx={{ fontSize: 9.5, color: "text.secondary", lineHeight: 1.25 }}>
        {label}
      </Typography>
    </Box>
  );
}

function Caveat({ children }: { children: ReactNode }) {
  return (
    <Typography sx={{ fontSize: 9.5, color: "text.secondary", lineHeight: 1.35, mt: 0.45 }}>
      {children}
    </Typography>
  );
}

export function WildfireLegend() {
  const t = useTranslations("wildfires");
  const zoom = useMapStore((state) => state.zoom);
  const panelOpen = useWildfireStore((state) => state.panelOpen);
  const layerVisible = useWildfireStore((state) => state.layerVisible);
  const dayRange = useWildfireStore((state) => state.dayRange);
  const source = useWildfireStore((state) => state.source);
  const showHotspots = useWildfireStore((state) => state.showHotspots);
  const showNifcPerimeters = useWildfireStore((state) => state.showNifcPerimeters);
  const showEffisBurnedAreas = useWildfireStore((state) => state.showEffisBurnedAreas);
  const showNoaaSmoke = useWildfireStore((state) => state.showNoaaSmoke);
  const showHeatmap = useWildfireStore((state) => state.showHeatmap);
  const statuses = useWildfireStore((state) => state.statuses);
  const setLayerVisible = useOverlayVisibilitySetter("wildfires");
  const setDayRange = useWildfireStore((state) => state.setDayRange);
  const setSource = useWildfireStore((state) => state.setSource);
  const setShowHotspots = useWildfireStore((state) => state.setShowHotspots);
  const setShowNifcPerimeters = useWildfireStore((state) => state.setShowNifcPerimeters);
  const setShowEffisBurnedAreas = useWildfireStore((state) => state.setShowEffisBurnedAreas);
  const setShowNoaaSmoke = useWildfireStore((state) => state.setShowNoaaSmoke);
  const setShowHeatmap = useWildfireStore((state) => state.setShowHeatmap);
  const loading =
    layerVisible &&
    ((showHotspots && statuses.firms.loading) ||
      (showNifcPerimeters && statuses.nifc.loading) ||
      (showEffisBurnedAreas && statuses.effis.loading) ||
      (showNoaaSmoke && statuses["noaa-hms"].loading));

  return (
    <OverlayLegend
      title={t("wildfires")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: "min(380px, calc(100vw - 24px))" }}
      headerSx={{ mb: 0.15 }}
    >
      <SourceRow
        id="firms"
        title={t("hotspotDetections")}
        coverage={t("coverageGlobal")}
        switchLabel={t("showHotspots")}
        checked={showHotspots}
        onChange={setShowHotspots}
        status={statuses.firms}
      >
        <Caveat>{t("firmsHotspotCaveat")}</Caveat>
        {showHotspots ? (
          <Box sx={{ mt: 0.65 }}>
            <Box sx={{ display: "flex", gap: 1.25, alignItems: "flex-end", flexWrap: "wrap" }}>
              <Box>
                <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
                  {t("hotspotAge")}
                </Typography>
                <ToggleButtonGroup
                  value={dayRange}
                  exclusive
                  onChange={(_, value) => value !== null && setDayRange(value)}
                  size="small"
                  sx={{ height: 26 }}
                >
                  {DAY_RANGES.map((days) => (
                    <ToggleButton
                      key={days}
                      value={days}
                      sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                    >
                      {t("nDays", { count: days })}
                    </ToggleButton>
                  ))}
                </ToggleButtonGroup>
              </Box>

              <Box>
                <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
                  {t("sensor")}
                </Typography>
                <ToggleButtonGroup
                  value={source}
                  exclusive
                  onChange={(_, value) => value && setSource(value)}
                  size="small"
                  sx={{ height: 26 }}
                >
                  <ToggleButton
                    value="VIIRS_SNPP_NRT"
                    sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                  >
                    {t("viirs375m")}
                  </ToggleButton>
                  <ToggleButton
                    value="MODIS_NRT"
                    sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                  >
                    {t("modis1km")}
                  </ToggleButton>
                </ToggleButtonGroup>
              </Box>

              <FormControlLabel
                label={<Typography sx={{ fontSize: 10 }}>{t("heatmap")}</Typography>}
                control={
                  <Switch
                    size="small"
                    checked={showHeatmap}
                    onChange={(event) => setShowHeatmap(event.target.checked)}
                  />
                }
                sx={{ m: 0, height: 26 }}
              />
            </Box>

            <Box
              sx={{
                display: "flex",
                gap: 1.5,
                mt: 0.7,
                alignItems: "flex-start",
                flexWrap: "wrap",
              }}
            >
              <Box>
                <Typography sx={{ fontSize: 9.5, color: "text.secondary", mb: 0.3 }}>
                  {t("recencyScale")}
                </Typography>
                <Box sx={{ display: "flex", gap: 0.55 }}>
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
                        component="span"
                        aria-hidden="true"
                        sx={{ width: 19, height: 9, borderRadius: "2px", bgcolor: entry.color }}
                      />
                      <Typography sx={{ fontSize: 8.5, lineHeight: 1.2, whiteSpace: "nowrap" }}>
                        {t(entry.labelKey)}
                      </Typography>
                    </Box>
                  ))}
                </Box>
              </Box>

              <Box>
                <Typography sx={{ fontSize: 9.5, color: "text.secondary", mb: 0.3 }}>
                  {t("frpSize")}
                </Typography>
                <Box sx={{ display: "flex", gap: 0.9, alignItems: "flex-end" }}>
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
                        component="span"
                        aria-hidden="true"
                        sx={{
                          width: entry.size,
                          height: entry.size,
                          borderRadius: "50%",
                          bgcolor: "#ef4444",
                          border: "1.5px solid var(--omx-overlay-bg)",
                          boxShadow: "0 0 0 0.5px var(--omx-shadow-soft)",
                        }}
                      />
                      <Typography sx={{ fontSize: 8.5, lineHeight: 1.2 }}>{entry.label}</Typography>
                    </Box>
                  ))}
                </Box>
              </Box>
            </Box>
          </Box>
        ) : null}
      </SourceRow>

      <SourceRow
        id="nifc"
        title={t("nifcPerimeters")}
        coverage={t("coverageUnitedStates")}
        switchLabel={t("showReportedPerimeters")}
        checked={showNifcPerimeters}
        onChange={setShowNifcPerimeters}
        status={statuses.nifc}
        zoomGated={zoom < 3}
      >
        <Box sx={{ mt: 0.45 }}>
          <Swatch
            label={t("reportedPerimeter")}
            fillColor={NIFC_PERIMETER_STYLE.fillColor}
            fillOpacity={NIFC_PERIMETER_STYLE.fillOpacity}
            lineColor={NIFC_PERIMETER_STYLE.lineColor}
          />
        </Box>
        <Caveat>{t("nifcCurrentPerimeterCaveat")}</Caveat>
      </SourceRow>

      <SourceRow
        id="effis"
        title={t("effisBurnedAreas")}
        coverage={t("coverageEffisRegion")}
        switchLabel={t("showSatelliteBurnedAreas")}
        checked={showEffisBurnedAreas}
        onChange={setShowEffisBurnedAreas}
        status={statuses.effis}
        zoomGated={zoom < 3}
      >
        <Box sx={{ mt: 0.45 }}>
          <Swatch
            label={t("effisSevenDayProduct")}
            fillColor={EFFIS_BURNED_AREA_STYLE.fillColor}
            fillOpacity={EFFIS_BURNED_AREA_STYLE.fillOpacity}
            lineColor={EFFIS_BURNED_AREA_STYLE.lineColor}
            dashed
          />
        </Box>
        <Caveat>{t("effisBurnedAreaCaveat")}</Caveat>
      </SourceRow>

      <SourceRow
        id="noaa-hms"
        title={t("observedSmoke")}
        coverage={t("coverageNorthAmerica")}
        switchLabel={t("showObservedSmoke")}
        checked={showNoaaSmoke}
        onChange={setShowNoaaSmoke}
        status={statuses["noaa-hms"]}
      >
        <Typography sx={{ fontSize: 9.5, color: "text.secondary", mt: 0.45, mb: 0.3 }}>
          {t("qualitativeDensity")}
        </Typography>
        <Box sx={{ display: "flex", gap: 0.85, flexWrap: "wrap" }}>
          {(["light", "medium", "heavy"] as const).map((density) => (
            <Swatch
              key={density}
              label={t(density)}
              fillColor={NOAA_SMOKE_STYLE.fillColor}
              fillOpacity={NOAA_SMOKE_OPACITY[density]}
              lineColor={NOAA_SMOKE_STYLE.lineColor}
            />
          ))}
        </Box>
        <Caveat>{t("noaaObservedSmokeCaveat")}</Caveat>
        <Caveat>{t("noaaSmokeDensityCaveat")}</Caveat>
      </SourceRow>
    </OverlayLegend>
  );
}
