"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
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
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-winter-sports");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const panelOpen = useWinterSportsStore((s) => s.panelOpen);
  const layerVisible = useWinterSportsStore((s) => s.layerVisible);
  const loading = useWinterSportsStore((s) => s.loading);
  const setLayerVisible = useWinterSportsStore((s) => s.setLayerVisible);

  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        whiteSpace: "nowrap",
        overflow: "hidden",
      }}
    >
      {loading && (
        <LinearProgress
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("pisteDifficulty")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>
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
      {/* Attribution (from manifest dataSources, trusted HTML) */}
      {attributionHtml && (
        <Typography
          variant="caption"
          dangerouslySetInnerHTML={{ __html: attributionHtml }}
          sx={{
            color: "text.secondary",
            mt: 0.75,
            display: "block",
            fontSize: 10.5,
          }}
        />
      )}
    </Paper>
  );
}
