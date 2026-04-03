"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useStreetViewStore } from "./store";

export function StreetViewLegend() {
  const t = useTranslations("streetView");
  const panelOpen = useStreetViewStore((s) => s.panelOpen);
  const layerVisible = useStreetViewStore((s) => s.layerVisible);
  const setLayerVisible = useStreetViewStore((s) => s.setLayerVisible);

  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        px: 2,
        py: 1.5,
        borderRadius: "12px",
      }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("coverage")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleCoverage") }}
        />
      </Box>

      <Box sx={{ display: "flex", flexDirection: "row", gap: 2 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 24, height: 3, bgcolor: "#03a9f4", borderRadius: "2px" }} />
          <Typography sx={{ fontSize: 12 }}>{t("streetLevelImagery")}</Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box sx={{ width: 24, height: 0, borderBottom: "2px dashed #03a9f4" }} />
          <Typography sx={{ fontSize: 12 }}>{t("photoSequence")}</Typography>
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          <Box
            sx={{
              width: 12,
              height: 12,
              border: "2px solid #03a9f4",
              borderRadius: "50%",
              bgcolor: "rgba(3,169,244,0.15)",
              flexShrink: 0,
            }}
          />
          <Typography sx={{ fontSize: 12 }}>{t("photo360")}</Typography>
        </Box>
      </Box>
    </Paper>
  );
}
