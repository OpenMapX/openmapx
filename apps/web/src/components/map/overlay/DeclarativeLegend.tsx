"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { integrationIdToOverlayId } from "@openmapx/core";
import type {
  IntegrationOverlayLegend,
  LoadedIntegrationMeta,
} from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import {
  useOverlayLayerVisible,
  useOverlayPanelOpen,
  useOverlaySetLayerVisible,
} from "./useOverlayStoreState";

/**
 * Renders an overlay legend entirely from its manifest `frontend.overlay.legend`
 * spec (categorical swatches or a value→color ramp) — no integration-shipped
 * legend code. Reuses the shared OverlayLegend chrome (title, toggle) so it
 * looks identical to built-in legends.
 *
 * Credits are not shown here: like every other legend, they belong to the map
 * credits strip, which the integration's own map layer registers into. A legend
 * is the wrong surface for them anyway — legends can be collapsed away entirely
 * from `LegendHost`, while the strip is always on.
 */
export function DeclarativeLegend({ integration }: { integration: LoadedIntegrationMeta }) {
  const legend = integration.frontend?.overlay?.legend;
  if (!legend) return null;
  return <DeclarativeLegendInner integration={integration} legend={legend} />;
}

function DeclarativeLegendInner({
  integration,
  legend,
}: {
  integration: LoadedIntegrationMeta;
  legend: IntegrationOverlayLegend;
}) {
  const t = useTranslations();
  const registry = useIntegrationRegistry();
  const meta = registry.get(integration.id);
  const overlayId = integrationIdToOverlayId(integration.id);
  const panelOpen = useOverlayPanelOpen(overlayId);
  const layerVisible = useOverlayLayerVisible(overlayId);
  const setLayerVisible = useOverlaySetLayerVisible(overlayId);

  const title = legend.titleKey
    ? t(legend.titleKey)
    : (legend.title ?? meta?.name ?? integration.id);
  const toggleAriaLabel = legend.titleKey ? t(legend.titleKey) : title;

  return (
    <OverlayLegend
      title={title}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={toggleAriaLabel}
      paperSx={{ whiteSpace: "nowrap" }}
      headerSx={{ mb: 1 }}
    >
      {legend.kind === "ramp" ? (
        <RampSwatches legend={legend} />
      ) : (
        <CategoricalSwatches legend={legend} resolveLabel={(key) => t(key)} />
      )}
    </OverlayLegend>
  );
}

function CategoricalSwatches({
  legend,
  resolveLabel,
}: {
  legend: IntegrationOverlayLegend;
  resolveLabel: (key: string) => string;
}) {
  return (
    <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5, flexWrap: "wrap" }}>
      {(legend.items ?? []).map((item) => (
        <Box
          key={`${item.color}-${item.labelKey ?? item.label ?? ""}`}
          sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}
        >
          <Box sx={{ width: 32, height: 16, borderRadius: "3px", bgcolor: item.color }} />
          <Typography sx={{ fontSize: 10, textAlign: "center", lineHeight: 1.25 }}>
            {item.labelKey ? resolveLabel(item.labelKey) : (item.label ?? "")}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}

function RampSwatches({ legend }: { legend: IntegrationOverlayLegend }) {
  const stops = legend.stops ?? [];
  const gradient = `linear-gradient(to right, ${stops.map((s) => s.color).join(", ")})`;
  return (
    <Box sx={{ minWidth: 180 }}>
      <Box sx={{ height: 12, borderRadius: "3px", background: gradient }} />
      <Box sx={{ display: "flex", justifyContent: "space-between", mt: 0.5 }}>
        {stops.map((s) => (
          <Typography key={`${s.value}-${s.color}`} sx={{ fontSize: 10 }}>
            {s.value}
          </Typography>
        ))}
      </Box>
    </Box>
  );
}
