"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useStreetLevelStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useStreetLevelProviders } from "./useStreetLevelProviders";

/**
 * One legend for every street-level-imagery provider. Colours come from each provider's
 * capabilities so the swatches match what the coverage layer actually draws.
 */
export function StreetLevelLegend() {
  const t = useTranslations("streetLevel");
  const panelOpen = useStreetLevelStore((s) => s.panelOpen);
  const layerVisible = useStreetLevelStore((s) => s.layerVisible);
  const setLayerVisible = useStreetLevelStore((s) => s.setLayerVisible);
  const { providers } = useStreetLevelProviders();

  if (!panelOpen) return null;

  return (
    <Paper elevation={3} sx={{ px: 2, py: 1.5, borderRadius: "12px" }}>
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("coverage")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          slotProps={{ input: { "aria-label": t("toggleCoverage") } }}
        />
      </Box>

      {providers.map((provider) => (
        <Box
          key={provider.id}
          sx={{ display: "flex", flexDirection: "row", gap: 2, alignItems: "center", mb: 0.75 }}
        >
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 96 }}>
            <Box sx={{ width: 24, height: 3, bgcolor: provider.color, borderRadius: "2px" }} />
            <Typography sx={{ fontSize: 12 }}>{provider.name}</Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                bgcolor: provider.color,
                border: "1px solid #fff",
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 12 }}>{t("photoSequence")}</Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
            <Box
              sx={{
                width: 12,
                height: 12,
                border: `2px solid ${provider.color}`,
                borderRadius: "50%",
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 12 }}>{t("photo360")}</Typography>
          </Box>
        </Box>
      ))}
    </Paper>
  );
}
