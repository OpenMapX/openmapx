"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution, relativeTime, useIntegrationRegistry } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { CATEGORY_COLORS } from "./map-layer";
import { ALL_CATEGORIES, useNaturalEventStore } from "./store";

const DAY_OPTIONS: { value: number | null; labelKey: string }[] = [
  { value: null, labelKey: "allOpen" },
  { value: 30, labelKey: "nDays" },
  { value: 90, labelKey: "nDays" },
  { value: 365, labelKey: "nDays" },
];

export function NaturalEventLegend() {
  const t = useTranslations("naturalEvents");
  const registry = useIntegrationRegistry();
  const meta = registry.get("overlay-natural-events");
  const attributionHtml = buildIntegrationAttribution(meta?.dataSources);
  const panelOpen = useNaturalEventStore((s) => s.panelOpen);
  const layerVisible = useNaturalEventStore((s) => s.layerVisible);
  const setLayerVisible = useNaturalEventStore((s) => s.setLayerVisible);
  const loading = useNaturalEventStore((s) => s.loading);
  const days = useNaturalEventStore((s) => s.days);
  const setDays = useNaturalEventStore((s) => s.setDays);
  const activeCategories = useNaturalEventStore((s) => s.activeCategories);
  const toggleCategory = useNaturalEventStore((s) => s.toggleCategory);
  const eventCount = useNaturalEventStore((s) => s.eventCount);
  const lastUpdated = useNaturalEventStore((s) => s.lastUpdated);

  if (!panelOpen) return null;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        overflow: "hidden",
        maxWidth: { xs: "90vw", sm: 420 },
        minWidth: 260,
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

      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.5 }}>
        <Typography sx={{ fontWeight: 600, fontSize: 14 }}>{t("naturalEvents")}</Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>

      {/* Time range */}
      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
          {t("timeRange")}
        </Typography>
        <ToggleButtonGroup
          value={days}
          exclusive
          size="small"
          onChange={(_, v) => {
            if (v !== undefined) setDays(v);
          }}
          sx={{ "& .MuiToggleButton-root": { px: 1.5, py: 0.25, fontSize: 12 } }}
        >
          {DAY_OPTIONS.map((opt) => (
            <ToggleButton key={String(opt.value)} value={opt.value}>
              {opt.value == null ? t("allOpen") : t("nDays", { count: opt.value })}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {/* Category chips */}
      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
          {t("categories")}
        </Typography>
        <Box
          sx={{
            display: "flex",
            gap: 0.5,
            flexWrap: "wrap",
          }}
        >
          {ALL_CATEGORIES.map((id) => {
            const active = activeCategories.has(id);
            const color = CATEGORY_COLORS[id] || "#78909c";
            return (
              <Chip
                key={id}
                label={t(id)}
                size="small"
                variant={active ? "filled" : "outlined"}
                onClick={() => toggleCategory(id)}
                sx={{
                  fontSize: 11,
                  height: 24,
                  ...(active
                    ? {
                        bgcolor: color,
                        color: "#fff",
                        "&:hover": { bgcolor: color, opacity: 0.9 },
                      }
                    : {
                        borderColor: color,
                        color: color,
                      }),
                }}
                icon={
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: "50%",
                      bgcolor: color,
                      ml: "4px !important",
                      mr: "-2px !important",
                      display: active ? "none" : "block",
                    }}
                  />
                }
              />
            );
          })}
        </Box>
      </Box>

      {/* Event count + last updated */}
      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
        {eventCount > 0
          ? t("eventsShowing", { count: eventCount })
          : loading
            ? t("loading")
            : t("noEvents")}
      </Typography>

      {lastUpdated && (
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.25 }}>
          {t("lastUpdated", { time: relativeTime(Date.now() - lastUpdated) })}
        </Typography>
      )}

      {/* Attribution (from manifest dataSources, trusted HTML) */}
      {attributionHtml && (
        <Typography
          variant="caption"
          color="text.secondary"
          sx={{ mt: 0.5, display: "block", fontSize: 10.5 }}
          dangerouslySetInnerHTML={{ __html: attributionHtml }}
        />
      )}
    </Paper>
  );
}
