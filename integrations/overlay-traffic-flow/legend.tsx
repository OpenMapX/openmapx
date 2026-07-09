"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution, combineAttributions } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useTrafficFlowStore } from "./store";

/** The five C5 color-gradient stops (green→dark-red), paired with the band's translation key. */
const BANDS: { color: string; key: string }[] = [
  { color: "#2ecc40", key: "freeFlow" },
  { color: "#ffd500", key: "light" },
  { color: "#ff8c00", key: "moderate" },
  { color: "#e8112d", key: "heavy" },
  { color: "#7e0023", key: "severe" },
];

/** The three confidence tiers driving `line-opacity`, faintest last. */
const CONFIDENCE_STEPS: { key: string; opacity: number }[] = [
  { key: "measured", opacity: 0.95 },
  { key: "estimated", opacity: 0.7 },
  { key: "typical", opacity: 0.4 },
];

/**
 * The actual NDW/Fintraffic/Trafikverket/NYC DOT feed credits live on the
 * external `road-conditions-openconditions` provider's manifest, registered
 * under the shared `road-conditions` domain — not on this overlay's own
 * (data-source-less) manifest. Aggregate across the domain, mirroring
 * `overlay-live-transit/legend.tsx`'s `buildProviderAttribution`.
 */
function buildProviderAttribution(registry: ReturnType<typeof useIntegrationRegistry>): string {
  return combineAttributions(
    registry
      .getByDomain("road-conditions")
      .map((integration) => buildIntegrationAttribution(integration.dataSources))
      .filter(Boolean),
  );
}

export function TrafficFlowLegend() {
  const t = useTranslations("trafficFlow");
  const registry = useIntegrationRegistry();
  const attributionHtml = buildProviderAttribution(registry);
  const panelOpen = useTrafficFlowStore((s) => s.panelOpen);
  const layerVisible = useTrafficFlowStore((s) => s.layerVisible);
  const setLayerVisible = useTrafficFlowStore((s) => s.setLayerVisible);

  return (
    <OverlayLegend
      title={t("trafficFlow")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      attributionHtml={attributionHtml}
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
          {CONFIDENCE_STEPS.map((step) => (
            <Box key={step.key} sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
              <Box
                sx={{
                  width: 9,
                  height: 9,
                  borderRadius: "2px",
                  bgcolor: "#2ecc40",
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

      <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>{t("coverageNote")}</Typography>
    </OverlayLegend>
  );
}
