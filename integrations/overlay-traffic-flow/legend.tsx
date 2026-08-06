"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { TRAFFIC_BAND_COLORS, type TrafficBand, useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useTrafficFlowStore } from "./store";
import { TRAFFIC_FLOW_CONFIDENCE_STEPS } from "./visual-style";

/** The five colour-gradient stops (green→dark-red); the key is also the i18n key. */
export const BANDS: { color: string; key: TrafficBand }[] = (
  ["freeFlow", "light", "moderate", "heavy", "severe"] as const
).map((key) => ({ key, color: TRAFFIC_BAND_COLORS[key] }));

export function TrafficFlowLegend() {
  const t = useTranslations("trafficFlow");
  const panelOpen = useTrafficFlowStore((s) => s.panelOpen);
  const layerVisible = useTrafficFlowStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("traffic-flow");

  return (
    <OverlayLegend
      title={t("trafficFlow")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 340 }, minWidth: 240 }}
    >
      <Box sx={{ mb: 1 }}>
        <Box sx={{ display: "flex", borderRadius: "4px", overflow: "hidden", height: 10 }}>
          {BANDS.map((band) => (
            <Box key={band.key} sx={{ flex: 1, bgcolor: band.color }} />
          ))}
        </Box>
        <Box sx={{ display: "flex", mt: 0.4 }}>
          {BANDS.map((band) => (
            <Typography
              key={band.key}
              sx={{ flex: 1, fontSize: 9.5, color: "text.secondary", textAlign: "center" }}
            >
              {t(`band.${band.key}`)}
            </Typography>
          ))}
        </Box>
      </Box>

      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.4 }}>
          {t("confidence.label")}
        </Typography>
        <Box sx={{ display: "flex", gap: 1 }}>
          {TRAFFIC_FLOW_CONFIDENCE_STEPS.map((step) => (
            <Box key={step.key} sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
              <Box
                data-testid={`traffic-flow-confidence-${step.key}`}
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: "2px",
                  bgcolor: TRAFFIC_BAND_COLORS.freeFlow,
                  opacity: step.opacity,
                }}
              />
              <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
                {t(`confidence.${step.key}`)}
              </Typography>
            </Box>
          ))}
        </Box>
      </Box>
    </OverlayLegend>
  );
}
