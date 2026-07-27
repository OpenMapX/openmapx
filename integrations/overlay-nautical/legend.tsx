"use client";

import AnchorIcon from "@mui/icons-material/Anchor";
import LocationOnIcon from "@mui/icons-material/LocationOn";
import MapIcon from "@mui/icons-material/Map";
import SailingIcon from "@mui/icons-material/Sailing";
import WavesIcon from "@mui/icons-material/Waves";
import Box from "@mui/material/Box";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { type TideStationFilter, useNauticalStore } from "./store";

const STATION_TYPE_SWATCHES: Array<{ key: string; color: string }> = [
  { key: "tide", color: "#0284c7" },
  { key: "waterLevel", color: "#0ea5e9" },
  { key: "currents", color: "#14b8a6" },
];

interface SubLayerRowProps {
  icon: ReactNode;
  label: string;
  description?: string;
  region?: string;
  checked: boolean;
  onChange: (value: boolean) => void;
}

function SubLayerRow({ icon, label, description, region, checked, onChange }: SubLayerRowProps) {
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1, py: 0.4 }}>
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          color: checked ? "primary.main" : "text.secondary",
          flexShrink: 0,
        }}
      >
        {icon}
      </Box>
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 500, lineHeight: 1.2, color: "text.primary" }}>
          {label}
          {region && (
            <Typography
              component="span"
              sx={{
                fontSize: 10.5,
                fontWeight: 500,
                color: "text.secondary",
                ml: 0.6,
                letterSpacing: 0.2,
                textTransform: "uppercase",
              }}
            >
              {region}
            </Typography>
          )}
        </Typography>
        {description && (
          <Typography sx={{ fontSize: 11, color: "text.secondary", lineHeight: 1.2, mt: 0.1 }}>
            {description}
          </Typography>
        )}
      </Box>
      <Switch
        size="small"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        inputProps={{ "aria-label": label }}
      />
    </Box>
  );
}

export function NauticalLegend() {
  const t = useTranslations("nautical");
  const panelOpen = useNauticalStore((s) => s.panelOpen);
  const layerVisible = useNauticalStore((s) => s.layerVisible);
  const loading = useNauticalStore((s) => s.loading);
  const showSeamarks = useNauticalStore((s) => s.showSeamarks);
  const showDepth = useNauticalStore((s) => s.showDepth);
  const showNoaaCharts = useNauticalStore((s) => s.showNoaaCharts);
  const showHarbors = useNauticalStore((s) => s.showHarbors);
  const showTideStations = useNauticalStore((s) => s.showTideStations);
  const tideStationFilter = useNauticalStore((s) => s.tideStationFilter);
  const setShowSeamarks = useNauticalStore((s) => s.setShowSeamarks);
  const setShowDepth = useNauticalStore((s) => s.setShowDepth);
  const setShowNoaaCharts = useNauticalStore((s) => s.setShowNoaaCharts);
  const setShowHarbors = useNauticalStore((s) => s.setShowHarbors);
  const setShowTideStations = useNauticalStore((s) => s.setShowTideStations);
  const setTideStationFilter = useNauticalStore((s) => s.setTideStationFilter);
  const setLayerVisible = useNauticalStore((s) => s.setLayerVisible);

  const handleFilterChange = (_e: unknown, value: TideStationFilter | null) => {
    if (value !== null) setTideStationFilter(value);
  };

  return (
    <OverlayLegend
      title={t("title")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "calc(100vw - 24px)", sm: 320 }, minWidth: 240 }}
      headerSx={{ mb: 0.6 }}
    >
      <Typography
        sx={{
          fontSize: 10.5,
          color: "text.secondary",
          letterSpacing: 0.4,
          textTransform: "uppercase",
          mb: 0.3,
        }}
      >
        {t("subLayersLabel")}
      </Typography>
      <Box sx={{ opacity: layerVisible ? 1 : 0.5, transition: "opacity 120ms" }}>
        <SubLayerRow
          icon={<SailingIcon sx={{ fontSize: 18 }} />}
          label={t("seamarks")}
          description={t("seamarksDescription")}
          checked={showSeamarks}
          onChange={setShowSeamarks}
        />
        <SubLayerRow
          icon={<WavesIcon sx={{ fontSize: 18 }} />}
          label={t("depth")}
          description={t("depthDescription")}
          checked={showDepth}
          onChange={setShowDepth}
        />
        <Tooltip title={t("outsideUsWaters")} placement="left" enterDelay={500}>
          <Box>
            <SubLayerRow
              icon={<MapIcon sx={{ fontSize: 18 }} />}
              label={t("noaaCharts")}
              description={t("noaaChartsDescription")}
              region={t("noaaChartsRegion")}
              checked={showNoaaCharts}
              onChange={setShowNoaaCharts}
            />
          </Box>
        </Tooltip>
        <SubLayerRow
          icon={<AnchorIcon sx={{ fontSize: 18 }} />}
          label={t("harbors")}
          description={t("harborsDescription")}
          checked={showHarbors}
          onChange={setShowHarbors}
        />
        <SubLayerRow
          icon={<LocationOnIcon sx={{ fontSize: 18 }} />}
          label={t("tideStations")}
          description={t("tideStationsDescription")}
          region={t("noaaChartsRegion")}
          checked={showTideStations}
          onChange={setShowTideStations}
        />

        {/* Filter chips + type color key, only shown when tide stations are on. */}
        {showTideStations && (
          <Box sx={{ display: "flex", gap: 1.5, mt: 0.6, ml: 3.5, flexWrap: "wrap" }}>
            <Box>
              <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
                {t("stationFilterLabel")}
              </Typography>
              <ToggleButtonGroup
                value={tideStationFilter}
                exclusive
                onChange={handleFilterChange}
                size="small"
                sx={{ height: 24 }}
              >
                <ToggleButton
                  value="all"
                  sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                >
                  {t("stationFilterAll")}
                </ToggleButton>
                <ToggleButton
                  value="tide"
                  sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                >
                  {t("stationFilterTide")}
                </ToggleButton>
                <ToggleButton
                  value="water-level"
                  sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                >
                  {t("stationFilterWaterLevel")}
                </ToggleButton>
                <ToggleButton
                  value="currents"
                  sx={{ fontSize: 10, px: 0.9, py: 0, textTransform: "none", minWidth: 0 }}
                >
                  {t("stationFilterCurrents")}
                </ToggleButton>
              </ToggleButtonGroup>
            </Box>

            <Box>
              <Typography sx={{ fontSize: 10, color: "text.secondary", mb: 0.3 }}>
                {t("stationTypesLabel")}
              </Typography>
              <Box
                sx={{
                  display: "grid",
                  gridTemplateColumns: "auto auto",
                  columnGap: 0.75,
                  rowGap: 0.2,
                  alignItems: "center",
                }}
              >
                {STATION_TYPE_SWATCHES.map(({ key, color }) => (
                  <Box key={key} sx={{ display: "contents" }}>
                    <Box
                      sx={{
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        bgcolor: color,
                        border: "1px solid #fff",
                      }}
                    />
                    <Typography sx={{ fontSize: 10, color: "text.secondary" }}>
                      {t(`stationType_${key}`)}
                    </Typography>
                  </Box>
                ))}
              </Box>
            </Box>
          </Box>
        )}
      </Box>
    </OverlayLegend>
  );
}

export default NauticalLegend;
