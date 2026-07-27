"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { SEVERITY_COLORS, TYPE_GLYPHS } from "./markers";
import { type MinSeverity, useRoadConditionsStore } from "./store";

/**
 * Types offered as filter chips — also the glyph legend, so the same row both
 * explains the marker icons and drives the `types` query filter. Curated to the
 * common road-event types; the rest still show when no type filter is active.
 */
const FILTER_TYPES = [
  "roadworks",
  "road_closure",
  "lane_closure",
  "accident",
  "congestion",
  "detour",
  "hazard",
  "obstruction",
] as const;

/** Min-severity threshold steps (low→high), each carrying its ramp color so the
 * control doubles as the severity color key. */
const SEVERITY_STEPS: { value: MinSeverity; color?: string }[] = [
  { value: "all" },
  { value: "low", color: SEVERITY_COLORS.low },
  { value: "medium", color: SEVERITY_COLORS.medium },
  { value: "high", color: SEVERITY_COLORS.high },
  { value: "critical", color: SEVERITY_COLORS.critical },
];

// Forward `className` so MUI's Chip can tag the svg with `.MuiChip-icon`
// (it clones the icon element and injects the class) — otherwise the icon
// styling, including the left-margin below, never applies.
function Glyph({ type, className }: { type: string; className?: string }) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path d={TYPE_GLYPHS[type] ?? (TYPE_GLYPHS.other as string)} fill="currentColor" />
    </svg>
  );
}

export function RoadConditionsLegend() {
  const t = useTranslations("roadConditions");
  const panelOpen = useRoadConditionsStore((s) => s.panelOpen);
  const layerVisible = useRoadConditionsStore((s) => s.layerVisible);
  const types = useRoadConditionsStore((s) => s.types);
  const minSeverity = useRoadConditionsStore((s) => s.minSeverity);
  const setLayerVisible = useRoadConditionsStore((s) => s.setLayerVisible);
  const toggleType = useRoadConditionsStore((s) => s.toggleType);
  const setMinSeverity = useRoadConditionsStore((s) => s.setMinSeverity);
  const resetFilters = useRoadConditionsStore((s) => s.resetFilters);
  const filtersActive = types.length > 0 || minSeverity !== "all";

  return (
    <OverlayLegend
      title={t("trafficIncidents")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      // This overlay's store tracks no fetch state, so the legend has no
      // loading bar to show.
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: "calc(100vw - 24px)" }}
    >
      <Box sx={{ mb: 0.75 }}>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.4 }}>
          {t("filterByType")}
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, maxWidth: 320 }}>
          {FILTER_TYPES.map((type) => {
            const selected = types.includes(type);
            return (
              <Chip
                key={type}
                size="small"
                icon={<Glyph type={type} />}
                label={t(`type.${type}`)}
                onClick={() => toggleType(type)}
                color={selected ? "primary" : "default"}
                variant={selected ? "filled" : "outlined"}
                sx={{ fontSize: 10.5, height: 24, "& .MuiChip-icon": { ml: 0.75, mr: -0.25 } }}
              />
            );
          })}
        </Box>
      </Box>

      <Box>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.4 }}>
          {t("severity")}
        </Typography>
        <ToggleButtonGroup
          value={minSeverity}
          exclusive
          onChange={(_, val: MinSeverity | null) => val && setMinSeverity(val)}
          size="small"
          sx={{ height: 26 }}
        >
          {SEVERITY_STEPS.map((step) => (
            <ToggleButton
              key={step.value}
              value={step.value}
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0, gap: 0.5 }}
            >
              {step.color ? (
                <Box sx={{ width: 9, height: 9, borderRadius: "50%", bgcolor: step.color }} />
              ) : null}
              {step.value === "all" ? t("all") : t(`sev.${step.value}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
        <Typography
          sx={{
            fontSize: 9.5,
            color: "text.secondary",
            mt: 0.4,
            display: "flex",
            alignItems: "center",
          }}
        >
          <Box
            component="span"
            sx={{
              width: 8,
              height: 8,
              borderRadius: "50%",
              bgcolor: SEVERITY_COLORS.unknown,
              mr: 0.5,
            }}
          />
          {t("sev.unknown")}
        </Typography>
      </Box>

      {filtersActive ? (
        <Box sx={{ mt: 0.75 }}>
          <Chip
            size="small"
            label={t("reset")}
            onClick={resetFilters}
            variant="outlined"
            sx={{ fontSize: 10.5, height: 22 }}
          />
        </Box>
      ) : null}
    </OverlayLegend>
  );
}

export default RoadConditionsLegend;
