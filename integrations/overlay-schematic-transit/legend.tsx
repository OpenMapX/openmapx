"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
import { SCHEMATIC_LAYOUTS, SCHEMATIC_NETWORKS, useSchematicTransitStore } from "./store";

export function SchematicTransitLegend() {
  const t = useTranslations("schematicTransit");
  const panelOpen = useSchematicTransitStore((s) => s.panelOpen);
  const layerVisible = useSchematicTransitStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("schematic-transit");
  const network = useSchematicTransitStore((s) => s.network);
  const setNetwork = useSchematicTransitStore((s) => s.setNetwork);
  const layout = useSchematicTransitStore((s) => s.layout);
  const setLayout = useSchematicTransitStore((s) => s.setLayout);

  return (
    <OverlayLegend
      title={t("title")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 380 } }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, mb: 1 }}>
        {SCHEMATIC_NETWORKS.map(({ id, labelKey }) => (
          <Chip
            key={id}
            label={t(labelKey)}
            size="small"
            variant={network === id ? "filled" : "outlined"}
            color={network === id ? "primary" : "default"}
            onClick={() => setNetwork(id)}
          />
        ))}
      </Box>
      <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5 }}>
        {SCHEMATIC_LAYOUTS.map(({ id, labelKey }) => (
          <Chip
            key={id}
            label={t(labelKey)}
            size="small"
            variant={layout === id ? "filled" : "outlined"}
            color={layout === id ? "primary" : "default"}
            onClick={() => setLayout(id)}
          />
        ))}
      </Box>
      <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 1 }}>
        {t("coverageNote")}
      </Typography>
    </OverlayLegend>
  );
}

export default SchematicTransitLegend;
