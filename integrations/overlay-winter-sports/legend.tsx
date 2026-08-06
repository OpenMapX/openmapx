"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useWinterSportsStore } from "./store";

const DIFFICULTY_ITEMS = [
  { key: "novice", color: "#4CAF50" },
  { key: "easy", color: "#2196F3" },
  { key: "intermediate", color: "#F44336" },
  { key: "advanced", color: "#212121" },
  { key: "expert", color: "#FF9800" },
  { key: "freeride", color: "#FFEB3B" },
] as const;

export function WinterSportsLegend() {
  const t = useTranslations("winterSports");
  const panelOpen = useWinterSportsStore((s) => s.panelOpen);
  const layerVisible = useWinterSportsStore((s) => s.layerVisible);
  const loading = useWinterSportsStore((s) => s.loading);
  const setLayerVisible = useOverlayVisibilitySetter("winter-sports");

  return (
    <OverlayLegend
      title={t("pisteDifficulty")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ whiteSpace: "nowrap" }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5 }}>
        {DIFFICULTY_ITEMS.map((d) => (
          <Box
            key={d.key}
            sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}
          >
            <Box
              sx={{
                width: 16,
                height: 16,
                borderRadius: "50%",
                bgcolor: d.color,
                border: d.key === "freeride" ? "1px solid var(--omx-border)" : "none",
              }}
            />
            <Typography
              sx={{ fontSize: 10, textAlign: "center", lineHeight: 1.25, whiteSpace: "pre-line" }}
            >
              {t(d.key)}
            </Typography>
          </Box>
        ))}
      </Box>
    </OverlayLegend>
  );
}
