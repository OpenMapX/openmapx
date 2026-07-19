"use client";

import AddLocationAltIcon from "@mui/icons-material/AddLocationAlt";
import EditLocationAltIcon from "@mui/icons-material/EditLocationAlt";
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
import { useTranslations } from "next-intl";
import { useState } from "react";
import { LocationMinimap } from "@/components/map/LocationMinimap";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";
import {
  buildReportClaim,
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
  const submit = useSubmitReport();

  const [category, setCategory] = useState<ReportCategory>("hazard_object");
  const [fuzziness, setFuzziness] = useState<FuzzinessChoice>("here");
  const [severity, setSeverity] = useState<1 | 2 | 3 | 4 | 5 | null>(null);

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
              {REPORT_CATEGORIES.map((c) => (
                <ToggleButton
                  key={c}
                  value={c}
                  size="small"
                  selected={category === c}
                  onChange={() => setCategory(c)}
                  sx={{ textTransform: "none" }}
                >
                  {t(`category.${c}`)}
                </ToggleButton>
              ))}
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
              {FUZZINESS_CHOICES.map((f) => (
                <ToggleButton
                  key={f}
                  value={f}
                  size="small"
                  selected={fuzziness === f}
                  onChange={() => setFuzziness(f)}
                  sx={{ textTransform: "none" }}
                >
                  {t(`fuzziness.${f}`)}
                </ToggleButton>
              ))}
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
                      borderColor: alpha(color, isSelected ? 1 : 0.45),
                      bgcolor: alpha(color, isSelected ? 0.4 : 0.14),
                      color: "text.primary",
                      fontSize: "1.2rem",
                      fontWeight: 600,
                      transition: (theme) =>
                        theme.transitions.create([
                          "background-color",
                          "border-color",
                          "box-shadow",
                        ]),
                      boxShadow: isSelected ? `0 0 0 3px ${alpha(color, 0.25)}` : "none",
                      "&:hover": { bgcolor: alpha(color, isSelected ? 0.48 : 0.26) },
                      "&.Mui-selected": {
                        bgcolor: alpha(color, 0.4),
                        color: "text.primary",
                        "&:hover": { bgcolor: alpha(color, 0.48) },
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
                is useless on a highway). Tapping it re-picks a point on the map. */}
            {location ? (
              <Box
                onClick={startPicking}
                role="button"
                tabIndex={0}
                aria-label={t("pickOnMap")}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    startPicking();
                  }
                }}
                sx={{
                  position: "relative",
                  width: "100%",
                  height: 160,
                  borderRadius: 1,
                  overflow: "hidden",
                  cursor: "pointer",
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
                <Box
                  sx={{
                    position: "absolute",
                    bottom: 8,
                    right: 8,
                    display: "flex",
                    alignItems: "center",
                    gap: 0.5,
                    px: 1,
                    py: 0.5,
                    borderRadius: 1,
                    bgcolor: "rgba(0,0,0,0.6)",
                    color: "#fff",
                    fontSize: "0.75rem",
                    pointerEvents: "none",
                  }}
                >
                  <EditLocationAltIcon sx={{ fontSize: "1rem" }} />
                  {t("pickOnMap")}
                </Box>
              </Box>
            ) : (
              <Button
                variant="outlined"
                fullWidth
                startIcon={<AddLocationAltIcon />}
                onClick={startPicking}
                sx={{ height: 160, textTransform: "none", borderStyle: "dashed" }}
              >
                {t("locationMissing")}
              </Button>
            )}
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
