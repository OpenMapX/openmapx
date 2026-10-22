"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Switch from "@mui/material/Switch";
import ToggleButton from "@mui/material/ToggleButton";
import ToggleButtonGroup from "@mui/material/ToggleButtonGroup";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import {
  useDataSourceColorKey,
  useDataSourceListing,
  useDataSourceName,
} from "@/integration-api/map/dataSourceOverlay";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
import { GLYPHS, glyphFor } from "./markers";
import { useRestoredRoadConditionsChoices } from "./restore-choices";
import { ROAD_SOURCE_IDS } from "./road-sources";
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

/**
 * Labels below every threshold step, keyed beside the control: a declared
 * absence of impact and a missing rating. Any threshold hides both.
 */
const UNRATED_KEYS = ["none", "unknown"] as const;

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

function SvgIcon({ path }: { path: string }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path d={path} fill="currentColor" />
    </svg>
  );
}

const CAPTION_SX = { fontSize: 10.5, color: "text.secondary", mb: 0.4 } as const;

/**
 * One layer the overlay can draw: its icon, name and a switch, with a line
 * below that explains the markers once they show (a colour key) or says why
 * nothing shows. The whole row is the switch's label.
 */
function LayerRow({
  icon,
  label,
  checked,
  onToggle,
  children,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onToggle: () => void;
  children?: ReactNode;
}) {
  return (
    <Box sx={{ py: 0.4 }}>
      <Box
        component="label"
        sx={{ display: "flex", alignItems: "center", gap: 1, cursor: "pointer" }}
      >
        <Box
          sx={{
            display: "flex",
            alignItems: "center",
            color: checked ? "primary.main" : "text.secondary",
            flexShrink: 0,
          }}
        >
          {icon}
        </Box>
        <Typography sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: 500, lineHeight: 1.2 }}>
          {label}
        </Typography>
        <Switch size="small" checked={checked} onChange={onToggle} />
      </Box>
      {checked && children ? <Box sx={{ pl: 3.25, pr: 1, mt: 0.25 }}>{children}</Box> : null}
    </Box>
  );
}

function RowNote({ children, role }: { children: ReactNode; role?: "status" }) {
  return (
    <Typography
      role={role}
      aria-live={role ? "polite" : undefined}
      sx={{ fontSize: 10.5, color: "text.secondary", lineHeight: 1.3 }}
    >
      {children}
    </Typography>
  );
}

/** A road data source's row: hidden when the server offers no such source. */
function RoadSourceRow({ sourceId }: { sourceId: string }) {
  const t = useTranslations("roadConditions");
  const listing = useDataSourceListing(sourceId);
  const name = useDataSourceName(sourceId);
  const colorKey = useDataSourceColorKey(sourceId);
  const shown = useRoadConditionsStore((s) => s.shownSources.includes(sourceId));
  const status = useRoadConditionsStore((s) => s.sourceStatus[sourceId]);
  const toggleSource = useRoadConditionsStore((s) => s.toggleSource);
  if (!listing) return null;

  let note: ReactNode = null;
  if (status?.state === "loading") note = <RowNote role="status">{t("source.loading")}</RowNote>;
  else if (status?.state === "error") note = <RowNote role="status">{t("source.error")}</RowNote>;
  else if (status?.state === "ready" && status.count === 0)
    note = <RowNote role="status">{t("source.empty")}</RowNote>;
  else if (colorKey.length > 0)
    note = (
      <Box sx={{ display: "flex", flexWrap: "wrap", columnGap: 1, rowGap: 0.25 }}>
        {colorKey.map((entry) => (
          <Box key={entry.id} sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
            <Box
              component="span"
              sx={{
                width: 9,
                height: 9,
                borderRadius: "50%",
                bgcolor: entry.color,
                border: "1px solid #fff",
                boxShadow: "0 0 0 0.5px rgba(0,0,0,0.25)",
              }}
            />
            <Typography sx={{ fontSize: 10.5, color: "text.secondary" }}>{entry.label}</Typography>
          </Box>
        ))}
      </Box>
    );

  return (
    <LayerRow
      icon={<SvgIcon path={listing.markerStyle.iconPath} />}
      label={name}
      checked={shown}
      onToggle={() => toggleSource(sourceId)}
    >
      {note}
    </LayerRow>
  );
}

/** The incidents' line key and filters: type, severity and time horizon. */
function IncidentControls() {
  const t = useTranslations("roadConditions");
  const hiddenKinds = useRoadConditionsStore((s) => s.hiddenKinds);
  const minSeverity = useRoadConditionsStore((s) => s.minSeverity);
  const horizon = useRoadConditionsStore((s) => s.horizon);
  const toggleKind = useRoadConditionsStore((s) => s.toggleKind);
  const setMinSeverity = useRoadConditionsStore((s) => s.setMinSeverity);
  const setHorizon = useRoadConditionsStore((s) => s.setHorizon);
  const resetFilters = useRoadConditionsStore((s) => s.resetFilters);
  const filtersActive = hiddenKinds.length > 0 || minSeverity !== "all" || horizon !== "active";

  return (
    <>
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
          {UNRATED_KEYS.map((label) => (
            <Box component="span" key={label} sx={{ display: "flex", alignItems: "center", mr: 1 }}>
              <Box
                component="span"
                sx={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  bgcolor: SEVERITY_COLORS[label],
                  mr: 0.5,
                }}
              />
              {t(`sev.${label}`)}
            </Box>
          ))}
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
    </>
  );
}

export function RoadConditionsLegend() {
  const t = useTranslations("roadConditions");
  useRestoredRoadConditionsChoices();
  const panelOpen = useRoadConditionsStore((s) => s.panelOpen);
  const layerVisible = useRoadConditionsStore((s) => s.layerVisible);
  const showIncidents = useRoadConditionsStore((s) => s.showIncidents);
  const toggleIncidents = useRoadConditionsStore((s) => s.toggleIncidents);
  const setLayerVisible = useOverlayVisibilitySetter("road-conditions");
  const viewportFetchStatus = useRoadConditionsStore((s) => s.viewportFetchStatus);
  const routeFetchStatus = useRoadConditionsStore((s) => s.routeFetchStatus);
  const sourcesLoading = useRoadConditionsStore((s) =>
    Object.values(s.sourceStatus).some((status) => status.state === "loading"),
  );
  const fetchStatus = [viewportFetchStatus, routeFetchStatus].includes("loading")
    ? "loading"
    : [viewportFetchStatus, routeFetchStatus].includes("error")
      ? "error"
      : [viewportFetchStatus, routeFetchStatus].includes("stale")
        ? "stale"
        : "ready";

  return (
    <OverlayLegend
      title={t("title")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={(showIncidents && fetchStatus === "loading") || sourcesLoading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "calc(100vw - 24px)", sm: 340 }, minWidth: 260 }}
      headerSx={{ mb: 0.6 }}
    >
      <Box sx={{ opacity: layerVisible ? 1 : 0.5, transition: "opacity 120ms" }}>
        <Typography
          sx={{
            fontSize: 10.5,
            color: "text.secondary",
            letterSpacing: 0.4,
            textTransform: "uppercase",
            mb: 0.3,
          }}
        >
          {t("layersLabel")}
        </Typography>
        <LayerRow
          icon={<SvgIcon path={GLYPHS.hazard as string} />}
          label={t("incidentsLayer")}
          checked={showIncidents}
          onToggle={toggleIncidents}
        >
          {fetchStatus !== "ready" ? (
            <RowNote role="status">{t(`status.${fetchStatus}`)}</RowNote>
          ) : null}
        </LayerRow>
        {ROAD_SOURCE_IDS.map((id) => (
          <RoadSourceRow key={id} sourceId={id} />
        ))}

        {showIncidents ? (
          <>
            <Divider sx={{ my: 1 }} />
            <Typography sx={{ ...CAPTION_SX, fontWeight: 600, color: "text.primary" }}>
              {t("incidentFilters")}
            </Typography>
            <IncidentControls />
          </>
        ) : null}
      </Box>
    </OverlayLegend>
  );
}

export default RoadConditionsLegend;
