"use client";

import type { SvgIconComponent } from "@mui/icons-material";
import AccessibleIcon from "@mui/icons-material/Accessible";
import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import CarCrashIcon from "@mui/icons-material/CarCrash";
import CarRepairIcon from "@mui/icons-material/CarRepair";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DoNotDisturbOnIcon from "@mui/icons-material/DoNotDisturbOn";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
import ElectricScooterIcon from "@mui/icons-material/ElectricScooter";
import EngineeringIcon from "@mui/icons-material/Engineering";
import LinearScaleIcon from "@mui/icons-material/LinearScale";
import MoreHorizIcon from "@mui/icons-material/MoreHoriz";
import MyLocationIcon from "@mui/icons-material/MyLocation";
import PetsIcon from "@mui/icons-material/Pets";
import PlaceIcon from "@mui/icons-material/Place";
import RemoveRoadIcon from "@mui/icons-material/RemoveRoad";
import ThunderstormIcon from "@mui/icons-material/Thunderstorm";
import VerticalAlignBottomIcon from "@mui/icons-material/VerticalAlignBottom";
import WarningIcon from "@mui/icons-material/Warning";
import Alert from "@mui/material/Alert";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import Stack from "@mui/material/Stack";
import { alpha } from "@mui/material/styles";
import ToggleButton from "@mui/material/ToggleButton";
import Typography from "@mui/material/Typography";
import { createSvgIcon } from "@mui/material/utils";
import { useMapStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { LocationMinimap } from "@/components/map/LocationMinimap";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";
import {
  buildReportClaim,
  defaultSeverityForCategory,
  type FuzzinessChoice,
  REPORT_CATEGORIES,
  type ReportCategory,
} from "./claim";
import { useCrowdReportStore } from "./store";
import { useSubmitReport } from "./useCrowdReports";

const FUZZINESS_CHOICES: FuzzinessChoice[] = ["here", "ahead", "back_of_queue", "all_along"];
const SEVERITY_LEVELS = [1, 2, 3, 4, 5] as const;

/**
 * Low→high severity ramp (green → dark red). Levels 2–5 reuse the incident
 * overlay palette so a reported severity matches how it's later drawn on the
 * map; level 1 adds a green low end. Rendered as translucent fills, not solid.
 */
const SEVERITY_COLORS: Record<(typeof SEVERITY_LEVELS)[number], string> = {
  1: "#2e9e4f",
  2: "#ffde33",
  3: "#ff9933",
  4: "#cc0033",
  5: "#7e0023",
};

// A queue of cars (the map's `congestion` glyph) — a better fit for "Stau" than
// a traffic light. Kept in sync with integrations/road-conditions/markers.ts.
const CongestionIcon = createSvgIcon(
  <path d="M20 10h-3V8.86c1.72-.45 3-2 3-3.86h-3V4c0-.55-.45-1-1-1H8c-.55 0-1 .45-1 1v1H4c0 1.86 1.28 3.41 3 3.86V10H4c0 1.86 1.28 3.41 3 3.86V15H4c0 1.86 1.28 3.41 3 3.86V20c0 .55.45 1 1 1h8c.55 0 1-.45 1-1v-1.14c1.72-.45 3-2 3-3.86h-3v-1.14c1.72-.45 3-2 3-3.86m-8 9c-1.11 0-2-.9-2-2s.89-2 2-2c1.1 0 2 .9 2 2s-.89 2-2 2m0-5c-1.11 0-2-.9-2-2s.89-2 2-2c1.1 0 2 .9 2 2s-.89 2-2 2m0-5c-1.11 0-2-.9-2-2 0-1.11.89-2 2-2 1.1 0 2 .89 2 2 0 1.1-.89 2-2 2" />,
  "Congestion",
);

/** Per-category icon, echoing the map's incident glyphs where one exists. */
const CATEGORY_ICONS: Record<ReportCategory, SvgIconComponent> = {
  road_closure: DoNotDisturbOnIcon,
  lane_closure: RemoveRoadIcon,
  accident: CarCrashIcon,
  stopped_vehicle: CarRepairIcon,
  hazard_object: WarningIcon,
  hazard_weather: ThunderstormIcon,
  hazard_animal: PetsIcon,
  jam: CongestionIcon,
  roadworks: EngineeringIcon,
  transit_disruption: DirectionsTransitIcon,
  micromobility: ElectricScooterIcon,
  accessibility: AccessibleIcon,
  other: MoreHorizIcon,
};

/**
 * Per-fuzziness icon, sketching where the condition sits: a pin here, an arrow
 * up the road ahead, the tail of a queue, or a whole segment.
 */
const FUZZINESS_ICONS: Record<FuzzinessChoice, SvgIconComponent> = {
  here: PlaceIcon,
  ahead: ArrowUpwardIcon,
  back_of_queue: VerticalAlignBottomIcon,
  all_along: LinearScaleIcon,
};

/** A glyph color legible on a `#rrggbb` disc — dark on light fills (yellow), white otherwise. */
function readableOn(hex: string): string {
  const r = Number.parseInt(hex.slice(1, 3), 16);
  const g = Number.parseInt(hex.slice(3, 5), 16);
  const b = Number.parseInt(hex.slice(5, 7), 16);
  return 0.299 * r + 0.587 * g + 0.114 * b > 180 ? "rgba(0,0,0,0.78)" : "#fff";
}

/**
 * The report dialog: pick a category, how far the condition extends (fuzziness),
 * an optional severity, then submit. Location comes from the store (map center,
 * or a point tapped on the map). On submit the claim is signed device-side and
 * relayed to the contributions-api (see `useSubmitReport`).
 */
export function ReportDialog() {
  const t = useTranslations("crowdReports");
  const fullScreen = useFullScreenOnMobile();
  const open = useCrowdReportStore((s) => s.open);
  const location = useCrowdReportStore((s) => s.location);
  const closeDialog = useCrowdReportStore((s) => s.closeDialog);
  const startPicking = useCrowdReportStore((s) => s.startPicking);
  const setLocation = useCrowdReportStore((s) => s.setLocation);
  const userLocation = useMapStore((s) => s.userLocation);
  const submit = useSubmitReport();

  const [category, setCategory] = useState<ReportCategory>("hazard_object");
  const [fuzziness, setFuzziness] = useState<FuzzinessChoice>("here");
  // Severity is optional but preselected from the category to save a tap; the
  // user can still change or clear it.
  const [severity, setSeverity] = useState<1 | 2 | 3 | 4 | 5 | null>(() =>
    defaultSeverityForCategory("hazard_object"),
  );

  // Picking a category preselects its typical severity (a deviation stays until
  // the next category change).
  const selectCategory = (c: ReportCategory) => {
    setCategory(c);
    setSeverity(defaultSeverityForCategory(c));
  };

  const handleSubmit = () => {
    if (!location) return;
    const claim = buildReportClaim({
      category,
      fuzziness,
      lon: location[0],
      lat: location[1],
      severityLevel: severity ?? undefined,
    });
    submit.mutate(claim, {
      onSuccess: () => {
        submit.reset();
        closeDialog();
      },
    });
  };

  return (
    <Dialog
      open={open}
      onClose={closeDialog}
      fullWidth
      maxWidth="sm"
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle>{t("reportTitle")}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={2}>
          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("categoryLabel")}
            </Typography>
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
              {REPORT_CATEGORIES.map((c) => {
                const Icon = CATEGORY_ICONS[c];
                const disc = SEVERITY_COLORS[defaultSeverityForCategory(c)];
                return (
                  <ToggleButton
                    key={c}
                    value={c}
                    size="small"
                    selected={category === c}
                    onChange={() => selectCategory(c)}
                    sx={{ textTransform: "none", gap: 0.75, pl: 0.75, pr: 1.25 }}
                  >
                    <Box
                      aria-hidden
                      sx={{
                        width: 26,
                        height: 26,
                        borderRadius: "50%",
                        flexShrink: 0,
                        display: "flex",
                        alignItems: "center",
                        justifyContent: "center",
                        bgcolor: disc,
                      }}
                    >
                      <Icon sx={{ fontSize: 17, color: readableOn(disc) }} />
                    </Box>
                    {t(`category.${c}`)}
                  </ToggleButton>
                );
              })}
            </Box>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("fuzzinessLabel")}
            </Typography>
            {/* Independent wrapping buttons (not a ToggleButtonGroup): a
                connected group's merged borders and end-only rounding break
                when items wrap to a second row. Mirrors the category control. */}
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1 }}>
              {FUZZINESS_CHOICES.map((f) => {
                const Icon = FUZZINESS_ICONS[f];
                return (
                  <ToggleButton
                    key={f}
                    value={f}
                    size="small"
                    selected={fuzziness === f}
                    onChange={() => setFuzziness(f)}
                    sx={{ textTransform: "none", gap: 0.5, pl: 1, pr: 1.25 }}
                  >
                    <Icon sx={{ fontSize: 18, color: "text.secondary" }} />
                    {t(`fuzziness.${f}`)}
                  </ToggleButton>
                );
              })}
            </Box>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 1 }}>
              {t("severityLabel")}
            </Typography>
            {/* Large round buttons spread across a capped width, each tinted on
                its severity color with a translucent (not solid) fill. */}
            <Box
              sx={{
                display: "flex",
                justifyContent: "space-between",
                gap: 1,
                maxWidth: 360,
              }}
            >
              {SEVERITY_LEVELS.map((s) => {
                const color = SEVERITY_COLORS[s];
                const isSelected = severity === s;
                return (
                  <ToggleButton
                    key={s}
                    value={s}
                    selected={isSelected}
                    onChange={() => setSeverity(isSelected ? null : s)}
                    aria-label={`${t("severityLabel")} ${s}`}
                    sx={{
                      flex: "0 0 auto",
                      width: 52,
                      height: 52,
                      p: 0,
                      borderRadius: "50%",
                      border: "2px solid",
                      // Selected reads as a solid colored disc (with legible
                      // number); unselected stays a faint tint.
                      borderColor: isSelected ? color : alpha(color, 0.45),
                      bgcolor: isSelected ? color : alpha(color, 0.14),
                      color: isSelected ? readableOn(color) : "text.primary",
                      fontSize: "1.2rem",
                      fontWeight: 700,
                      transition: (theme) =>
                        theme.transitions.create([
                          "background-color",
                          "border-color",
                          "box-shadow",
                        ]),
                      boxShadow: isSelected ? `0 0 0 3px ${alpha(color, 0.3)}` : "none",
                      "&:hover": { bgcolor: isSelected ? color : alpha(color, 0.26) },
                      "&.Mui-selected": {
                        bgcolor: color,
                        color: readableOn(color),
                        "&:hover": { bgcolor: color },
                      },
                    }}
                  >
                    {s}
                  </ToggleButton>
                );
              })}
            </Box>
          </Box>

          <Box>
            <Typography variant="subtitle2" sx={{ mb: 0.5 }}>
              {t("locationLabel")}
            </Typography>
            {/* A minimap reads better than raw coordinates (or an address, which
                is useless on a highway). The buttons below set the point. */}
            {location ? (
              <Box
                sx={{
                  position: "relative",
                  width: "100%",
                  height: 160,
                  borderRadius: 1,
                  overflow: "hidden",
                  border: "1px solid",
                  borderColor: "divider",
                }}
              >
                <LocationMinimap
                  lng={location[0]}
                  lat={location[1]}
                  zoom={15}
                  sx={{ position: "absolute", inset: 0 }}
                />
              </Box>
            ) : (
              <Box
                sx={{
                  height: 160,
                  borderRadius: 1,
                  border: "1px dashed",
                  borderColor: "divider",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <Typography variant="body2" color="text.secondary">
                  {t("locationMissing")}
                </Typography>
              </Box>
            )}
            <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
              <Button
                variant="outlined"
                fullWidth
                startIcon={<MyLocationIcon />}
                disabled={!userLocation}
                onClick={() => userLocation && setLocation(userLocation)}
                sx={{ textTransform: "none" }}
              >
                {t("useCurrentLocation")}
              </Button>
              <Button
                variant="outlined"
                fullWidth
                startIcon={<EditLocationAltIcon />}
                onClick={startPicking}
                sx={{ textTransform: "none" }}
              >
                {t("pickOnMap")}
              </Button>
            </Stack>
          </Box>

          {submit.isError && <Alert severity="error">{t("submitError")}</Alert>}
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button onClick={closeDialog}>{t("cancel")}</Button>
        <Button variant="contained" onClick={handleSubmit} disabled={!location || submit.isPending}>
          {t("submit")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
