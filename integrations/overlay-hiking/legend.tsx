"use client";

import Box from "@mui/material/Box";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import { SAC_GRADES } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useHikingStore } from "./store";

const GRADES = [
  "hiking",
  "mountain_hiking",
  "demanding_mountain_hiking",
  "alpine_hiking",
  "demanding_alpine_hiking",
  "difficult_alpine_hiking",
] as const;

const SHELTER_ITEMS = [
  { labelKey: "refuge", color: "#D84315" },
  { labelKey: "cabin", color: "#795548" },
  { labelKey: "guesthouse", color: "#5D4037" },
  { labelKey: "waterPoint", color: "#0288D1" },
] as const;

export function HikingTrailsLegend() {
  const t = useTranslations("hiking");
  const panelOpen = useHikingStore((s) => s.panelOpen);
  const layerVisible = useHikingStore((s) => s.layerVisible);
  const loading = useHikingStore((s) => s.loading);
  const setLayerVisible = useHikingStore((s) => s.setLayerVisible);

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
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("trailDifficulty")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>

      <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5 }}>
        {GRADES.map((key) => {
          const grade = SAC_GRADES[key];
          return (
            <Box
              key={key}
              sx={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 0.5 }}
            >
              <Box
                sx={{
                  width: 24,
                  height: 4,
                  borderRadius: "2px",
                  bgcolor: grade.color,
                }}
              />
              <Typography
                sx={{
                  fontSize: 10,
                  textAlign: "center",
                  lineHeight: 1.25,
                  whiteSpace: "pre-line",
                }}
              >
                {grade.grade}
              </Typography>
            </Box>
          );
        })}
      </Box>

      <Box sx={{ display: "flex", flexDirection: "row", gap: 1.5, mt: 0.75 }}>
        {SHELTER_ITEMS.map((s) => (
          <Box key={s.labelKey} sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
            <Box
              sx={{
                width: 10,
                height: 10,
                borderRadius: "50%",
                bgcolor: s.color,
                border: "1.5px solid var(--omx-overlay-bg)",
                boxShadow: "0 0 0 0.5px var(--omx-border-light)",
                flexShrink: 0,
              }}
            />
            <Typography sx={{ fontSize: 10, lineHeight: 1.25 }}>{t(s.labelKey)}</Typography>
          </Box>
        ))}
      </Box>

      <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.75 }}>
        {t("attribution")} ·{" "}
        <a
          href="https://hiking.waymarkedtrails.org"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          Waymarked Trails
        </a>{" "}
        /{" "}
        <a
          href="https://www.openstreetmap.org/copyright"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          OSM
        </a>
      </Typography>
    </Paper>
  );
}
