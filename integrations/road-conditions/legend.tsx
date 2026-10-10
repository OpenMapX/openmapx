"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
import { GLYPHS, glyphFor } from "./markers";
import { SEVERITY_COLORS } from "./severity";
import { type Horizon, type MinSeverity, useRoadConditionsStore } from "./store";
import {
  ROAD_CONDITION_ACTIVE_LINE_DASHARRAY,
  ROAD_CONDITION_ACTIVE_LINE_OPACITY,
  ROAD_CONDITION_FUTURE_LINE_DASHARRAY,
  ROAD_CONDITION_FUTURE_LINE_OPACITY,
} from "./visual-style";

/**
 * Registry kinds offered as filter chips — also the glyph legend, so the same
 * row both explains the marker icons and hides a kind from the query when
 * turned off. Curated to the common road situations; the other kinds always
 * show.
 */
const FILTER_KINDS = [
  "roadworks",
  "closure",
  "incident",
  "congestion",
  "restriction",
  "road_hazard",
  "weather_condition",
  "public_event",
] as const;

/** Min-severity threshold steps (minor→critical), each carrying its ramp color
 * so the control doubles as the severity color key. */
const SEVERITY_STEPS: { value: MinSeverity; color?: string }[] = [
  { value: "all" },
  { value: "minor", color: SEVERITY_COLORS.minor },
  { value: "moderate", color: SEVERITY_COLORS.moderate },
  { value: "major", color: SEVERITY_COLORS.major },
  { value: "critical", color: SEVERITY_COLORS.critical },
];

/** Time-horizon steps, narrowest first — the default is the first. */
const HORIZON_STEPS: Horizon[] = ["active", "week", "all"];

// Forward `className` so MUI's Chip can tag the svg with `.MuiChip-icon`
// (it clones the icon element and injects the class) — otherwise the icon
// styling, including the left-margin below, never applies.
function Glyph({ kind, className }: { kind: string; className?: string }) {
  return (
    <svg className={className} width="13" height="13" viewBox="0 0 24 24" aria-hidden="true">
      <path d={GLYPHS[glyphFor(kind)] ?? (GLYPHS.other as string)} fill="currentColor" />
    </svg>
  );
}

export function RoadConditionsLegend() {
  const t = useTranslations("roadConditions");
  const panelOpen = useRoadConditionsStore((s) => s.panelOpen);
  const layerVisible = useRoadConditionsStore((s) => s.layerVisible);
  const hiddenKinds = useRoadConditionsStore((s) => s.hiddenKinds);
  const minSeverity = useRoadConditionsStore((s) => s.minSeverity);
  const horizon = useRoadConditionsStore((s) => s.horizon);
  const setLayerVisible = useOverlayVisibilitySetter("road-conditions");
  const toggleKind = useRoadConditionsStore((s) => s.toggleKind);
  const setMinSeverity = useRoadConditionsStore((s) => s.setMinSeverity);
  const setHorizon = useRoadConditionsStore((s) => s.setHorizon);
  const resetFilters = useRoadConditionsStore((s) => s.resetFilters);
  const viewportFetchStatus = useRoadConditionsStore((s) => s.viewportFetchStatus);
  const routeFetchStatus = useRoadConditionsStore((s) => s.routeFetchStatus);
  const filtersActive = hiddenKinds.length > 0 || minSeverity !== "all" || horizon !== "active";
  const fetchStatus = [viewportFetchStatus, routeFetchStatus].includes("loading")
    ? "loading"
    : [viewportFetchStatus, routeFetchStatus].includes("error")
      ? "error"
      : [viewportFetchStatus, routeFetchStatus].includes("stale")
        ? "stale"
        : "ready";

  return (
    <OverlayLegend
      title={t("trafficIncidents")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={fetchStatus === "loading"}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: "calc(100vw - 24px)" }}
    >
      {fetchStatus !== "ready" ? (
        <Typography
          role="status"
          aria-live="polite"
          sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.75 }}
        >
          {t(`status.${fetchStatus}`)}
        </Typography>
      ) : null}

      <Box sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.4 }}>
          {t("line.label")}
        </Typography>
        <Box sx={{ display: "flex", gap: 1.25, alignItems: "center" }}>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
            <Box
              data-testid="road-conditions-line-active"
              data-line-opacity={ROAD_CONDITION_ACTIVE_LINE_OPACITY}
              data-line-dasharray={ROAD_CONDITION_ACTIVE_LINE_DASHARRAY.join(",")}
              component="span"
              sx={{
                width: 24,
                borderTop: `3px solid ${SEVERITY_COLORS.moderate}`,
                opacity: ROAD_CONDITION_ACTIVE_LINE_OPACITY,
              }}
            />
            <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
              {t("line.active")}
            </Typography>
          </Box>
          <Box sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
            <Box
              data-testid="road-conditions-line-future"
              data-line-opacity={ROAD_CONDITION_FUTURE_LINE_OPACITY}
              data-line-dasharray={ROAD_CONDITION_FUTURE_LINE_DASHARRAY.join(",")}
              component="span"
              sx={{
                width: 24,
                borderTop: `3px dashed ${SEVERITY_COLORS.moderate}`,
                opacity: ROAD_CONDITION_FUTURE_LINE_OPACITY,
              }}
            />
            <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>
              {t("line.future")}
            </Typography>
          </Box>
        </Box>
      </Box>

      <Box sx={{ mb: 0.75 }}>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.4 }}>
          {t("filterByType")}
        </Typography>
        <Box sx={{ display: "flex", flexWrap: "wrap", gap: 0.5, maxWidth: 320 }}>
          {FILTER_KINDS.map((kind) => {
            const shown = !hiddenKinds.includes(kind);
            return (
              <Chip
                key={kind}
                size="small"
                icon={<Glyph kind={kind} />}
                label={t(`kind.${kind}`)}
                onClick={() => toggleKind(kind)}
                aria-pressed={shown}
                color={shown ? "primary" : "default"}
                variant={shown ? "filled" : "outlined"}
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

      <Box sx={{ mt: 0.75 }}>
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mb: 0.4 }}>
          {t("timeHorizon")}
        </Typography>
        <ToggleButtonGroup
          value={horizon}
          exclusive
          onChange={(_, val: Horizon | null) => val && setHorizon(val)}
          size="small"
          sx={{ height: 26 }}
        >
          {HORIZON_STEPS.map((step) => (
            <ToggleButton
              key={step}
              value={step}
              sx={{ fontSize: 10.5, px: 1, py: 0, textTransform: "none", minWidth: 0 }}
            >
              {t(`horizon.${step}`)}
            </ToggleButton>
          ))}
        </ToggleButtonGroup>
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
