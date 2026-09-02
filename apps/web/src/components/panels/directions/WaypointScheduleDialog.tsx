"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Dialog from "@mui/material/Dialog";
import DialogActions from "@mui/material/DialogActions";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import FormControlLabel from "@mui/material/FormControlLabel";
import FormLabel from "@mui/material/FormLabel";
import Radio from "@mui/material/Radio";
import RadioGroup from "@mui/material/RadioGroup";
import Typography from "@mui/material/Typography";
import type { LngLat, WaypointSchedule } from "@openmapx/core";
import { timeZoneAt, tzOffsetLabel } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BRAND } from "@/integration-api/runtime/theme";

/** Matches the wall-clock shape the routing API accepts. */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MAX_DWELL_MINUTES = 1440;

type ConstraintKind = "none" | "departAfter" | "arriveBy" | "fixedAt";

/**
 * Compact chip text for a constrained waypoint, e.g. `14:00 · 30 min`. Returns
 * null for an unconstrained stop so the row can stay quiet.
 */
export function describeSchedule(
  schedule: WaypointSchedule | undefined,
  formatTime: (wallClock: string) => string,
): string | null {
  if (!schedule) return null;
  const wallClock = schedule.fixedAt ?? schedule.arriveBy ?? schedule.departAfter;
  const minutes = schedule.dwellSeconds ? Math.round(schedule.dwellSeconds / 60) : 0;
  const parts = [
    wallClock ? formatTime(wallClock) : null,
    minutes > 0 ? `${minutes} min` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

function kindOf(schedule: WaypointSchedule | undefined): ConstraintKind {
  if (schedule?.fixedAt) return "fixedAt";
  if (schedule?.arriveBy) return "arriveBy";
  if (schedule?.departAfter) return "departAfter";
  return "none";
}

export interface WaypointScheduleDialogProps {
  open: boolean;
  waypointLabel: string;
  coords: LngLat;
  schedule: WaypointSchedule | undefined;
  onSave: (schedule: WaypointSchedule | null) => void;
  onClose: () => void;
}

/**
 * Edits one stop's temporal constraints. Every time is entered and shown in the
 * stop's own zone, which is why the resolved zone is stated rather than left to
 * the reader's own clock.
 */
export function WaypointScheduleDialog({
  open,
  waypointLabel,
  coords,
  schedule,
  onSave,
  onClose,
}: WaypointScheduleDialogProps) {
  const t = useTranslations("directions");
  const [kind, setKind] = useState<ConstraintKind>(() => kindOf(schedule));
  const [wallClock, setWallClock] = useState(
    () => schedule?.fixedAt ?? schedule?.arriveBy ?? schedule?.departAfter ?? "",
  );
  const [dwellMinutes, setDwellMinutes] = useState(() =>
    schedule?.dwellSeconds ? String(Math.round(schedule.dwellSeconds / 60)) : "",
  );
  const [timeError, setTimeError] = useState<string | null>(null);
  const [dwellError, setDwellError] = useState<string | null>(null);

  // Reopening on a different stop must not show the previous stop's values.
  useEffect(() => {
    if (!open) return;
    setKind(kindOf(schedule));
    setWallClock(schedule?.fixedAt ?? schedule?.arriveBy ?? schedule?.departAfter ?? "");
    setDwellMinutes(schedule?.dwellSeconds ? String(Math.round(schedule.dwellSeconds / 60)) : "");
    setTimeError(null);
    setDwellError(null);
  }, [open, schedule]);

  const timeZone = timeZoneAt(coords[1], coords[0]) ?? "UTC";
  const offset = tzOffsetLabel(new Date(), timeZone) ?? "UTC";
  const zoneHint = t("scheduleTimeZone", { zone: timeZone, offset });

  const handleSave = () => {
    const minutes = dwellMinutes.trim() === "" ? 0 : Number(dwellMinutes);
    const dwellValid = Number.isInteger(minutes) && minutes >= 0 && minutes <= MAX_DWELL_MINUTES;
    const timeValid = kind === "none" || WALL_CLOCK.test(wallClock);
    setDwellError(dwellValid ? null : t("scheduleInvalidDwell"));
    setTimeError(timeValid ? null : t("scheduleInvalidTime"));
    if (!dwellValid || !timeValid) return;

    if (kind === "none" && minutes === 0) {
      onSave(null);
      onClose();
      return;
    }
    onSave({
      ...(kind !== "none" ? { [kind]: wallClock } : {}),
      ...(minutes > 0 ? { dwellSeconds: minutes * 60 } : {}),
      // Always carried so a link shared across zones keeps its meaning.
      timeZone,
    });
    onClose();
  };

  return (
    <Dialog open={open} onClose={onClose} fullWidth maxWidth="xs">
      <DialogTitle sx={{ pb: 1 }}>{waypointLabel || t("scheduleStop")}</DialogTitle>
      <DialogContent sx={{ display: "flex", flexDirection: "column", gap: 2 }}>
        <Box>
          <FormLabel id="schedule-kind-label" sx={{ fontSize: "0.8125rem" }}>
            {t("scheduleStop")}
          </FormLabel>
          <RadioGroup
            aria-labelledby="schedule-kind-label"
            value={kind}
            onChange={(event) => setKind(event.target.value as ConstraintKind)}
          >
            {(["none", "departAfter", "arriveBy", "fixedAt"] as const).map((option) => (
              <FormControlLabel
                key={option}
                value={option}
                control={<Radio size="small" />}
                label={
                  option === "none"
                    ? t("scheduleNone")
                    : option === "departAfter"
                      ? t("scheduleDepartAfter")
                      : option === "arriveBy"
                        ? t("scheduleArriveBy")
                        : t("scheduleFixedAt")
                }
              />
            ))}
          </RadioGroup>
        </Box>

        {kind !== "none" && (
          <Box>
            <Box
              component="input"
              type="datetime-local"
              data-testid="schedule-time-input"
              aria-label={
                kind === "departAfter"
                  ? t("scheduleDepartAfter")
                  : kind === "arriveBy"
                    ? t("scheduleArriveBy")
                    : t("scheduleFixedAt")
              }
              aria-describedby="schedule-zone-hint"
              value={wallClock}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setWallClock(event.target.value)
              }
              sx={{
                border: "1px solid",
                borderColor: timeError ? "error.main" : "divider",
                borderRadius: "8px",
                px: 1.5,
                py: 0.75,
                fontSize: "0.875rem",
                fontFamily: "inherit",
                color: "text.primary",
                bgcolor: "background.paper",
                outline: "none",
                "&:focus": { borderColor: BRAND },
                width: "100%",
                boxSizing: "border-box",
              }}
            />
            {timeError && (
              <Typography variant="caption" color="error" sx={{ display: "block", mt: 0.5 }}>
                {timeError}
              </Typography>
            )}
          </Box>
        )}

        <Box>
          <FormLabel htmlFor="schedule-dwell" sx={{ fontSize: "0.8125rem" }}>
            {t("scheduleDwell")}
          </FormLabel>
          <Box sx={{ display: "flex", alignItems: "center", gap: 1, mt: 0.5 }}>
            <Box
              component="input"
              id="schedule-dwell"
              type="number"
              min={0}
              max={MAX_DWELL_MINUTES}
              data-testid="schedule-dwell-input"
              aria-label={t("scheduleDwell")}
              aria-describedby="schedule-zone-hint"
              value={dwellMinutes}
              onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                setDwellMinutes(event.target.value)
              }
              sx={{
                border: "1px solid",
                borderColor: dwellError ? "error.main" : "divider",
                borderRadius: "8px",
                px: 1.5,
                py: 0.75,
                fontSize: "0.875rem",
                fontFamily: "inherit",
                color: "text.primary",
                bgcolor: "background.paper",
                outline: "none",
                "&:focus": { borderColor: BRAND },
                width: 96,
              }}
            />
            <Typography variant="body2" color="text.secondary">
              {t("scheduleDwellMinutes")}
            </Typography>
          </Box>
          {dwellError && (
            <Typography variant="caption" color="error" sx={{ display: "block", mt: 0.5 }}>
              {dwellError}
            </Typography>
          )}
        </Box>

        <Typography id="schedule-zone-hint" variant="caption" color="text.secondary">
          {zoneHint}
        </Typography>
      </DialogContent>
      <DialogActions>
        <Button
          onClick={() => {
            onSave(null);
            onClose();
          }}
        >
          {t("scheduleClear")}
        </Button>
        <Button onClick={onClose}>{t("scheduleCancel")}</Button>
        <Button onClick={handleSave} variant="contained">
          {t("scheduleSave")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
