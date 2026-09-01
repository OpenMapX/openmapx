"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { CYCLING_COLORS } from "@/integration-api/map/cyclingConfig";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
import { useCyclingStore } from "./store";

const LINE_ITEMS = [
  { colorKey: "track" as const, labelKey: "dedicatedCycleway", style: "solid" },
  { colorKey: "lane" as const, labelKey: "bikeLane", style: "dashed" },
  { colorKey: "designated" as const, labelKey: "bicycleDesignated", style: "solid" },
  { colorKey: "permitted" as const, labelKey: "bicyclePermitted", style: "dashdot" },
] as const;

const POI_ITEMS = [
  { colorKey: "parking" as const, labelKey: "bikeParking" },
  { colorKey: "shop" as const, labelKey: "bikeShop" },
  { colorKey: "repair" as const, labelKey: "repairStation" },
  { colorKey: "rental" as const, labelKey: "bikeRental" },
] as const;

function LineSymbol({ color, style }: { color: string; style: string }) {
  if (style === "dashed") {
    return (
      <Box
        sx={{
          width: 24,
          height: 0,
          borderBottom: `3px dashed ${color}`,
          flexShrink: 0,
        }}
      />
    );
  }
  if (style === "dashdot") {
    return (
      <svg width="24" height="4" style={{ flexShrink: 0 }} role="img" aria-label="dash-dot line">
        <line
          x1="0"
          y1="2"
          x2="24"
          y2="2"
          stroke={color}
          strokeWidth="3"
          strokeDasharray="6,3,2,3"
        />
      </svg>
    );
  }
  return (
    <Box
      sx={{
        width: 24,
        height: 3,
        bgcolor: color,
        borderRadius: "2px",
        flexShrink: 0,
      }}
    />
  );
}

export function CyclingLegend() {
  const t = useTranslations("cycling");
  const panelOpen = useCyclingStore((s) => s.panelOpen);
  const layerVisible = useCyclingStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("cycling");

  return (
    <OverlayLegend
      title={t("cyclingInfrastructure")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      // The overlay restyles source-layers the basemap already loads, so there
      // is nothing to fetch and no credit of its own to show.
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ whiteSpace: "nowrap" }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "flex", flexDirection: "row", gap: 2 }}>
        {LINE_ITEMS.map((item) => (
          <Box key={item.colorKey} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <LineSymbol color={CYCLING_COLORS[item.colorKey]} style={item.style} />
            <Typography sx={{ fontSize: 11, lineHeight: 1.25 }}>{t(item.labelKey)}</Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: "flex", flexDirection: "row", gap: 2, mt: 0.75 }}>
        {POI_ITEMS.map((item) => (
          <Box key={item.colorKey} sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                bgcolor: CYCLING_COLORS[item.colorKey],
                border: "1.5px solid var(--omx-overlay-bg)",
                boxShadow: "0 0 0 0.5px var(--omx-border-light)",
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 11, lineHeight: 1.25 }}>{t(item.labelKey)}</Typography>
          </Box>
        ))}
      </Box>
    </OverlayLegend>
  );
}
