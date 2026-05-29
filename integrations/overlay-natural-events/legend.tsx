"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { buildIntegrationAttribution, relativeTime } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
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

  return (
    <OverlayLegend
      title={t("naturalEvents")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      attributionHtml={attributionHtml}
      paperSx={{ maxWidth: { xs: "90vw", sm: 420 }, minWidth: 260 }}
      headerSx={{ mb: 0.5 }}
      attributionSx={{ mt: 0.5, display: "block", fontSize: 10.5 }}
    >
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
    </OverlayLegend>
  );
}
