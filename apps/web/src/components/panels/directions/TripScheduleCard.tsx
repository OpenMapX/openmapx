"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type {
  ScheduleFidelity,
  SchedulePlanWarning,
  ScheduleViolation,
  TripSchedule,
} from "@openmapx/core";
import { formatDuration, viewerTimeZone } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { Fragment } from "react";

/**
 * The clock part of an ISO string that already carries its stop's own offset.
 * Parsing it into a `Date` would re-render it in the viewer's zone, which is
 * exactly what the schedule is designed to avoid.
 */
function clockOf(iso: string): string {
  return iso.slice(11, 16);
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

function offsetLabel(minutes: number): string {
  if (minutes === 0) return "UTC";
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  const hours = Math.floor(absolute / 60);
  const rest = absolute % 60;
  return rest === 0 ? `UTC${sign}${hours}` : `UTC${sign}${hours}:${String(rest).padStart(2, "0")}`;
}

export interface TripScheduleCardProps {
  schedule: TripSchedule;
  fidelity: ScheduleFidelity;
  warnings: SchedulePlanWarning[];
  /** Display labels indexed by waypoint index. */
  waypointLabels: string[];
}

export function TripScheduleCard({
  schedule,
  fidelity,
  warnings,
  waypointLabels,
}: TripScheduleCardProps) {
  const t = useTranslations("directions");
  const localZone = viewerTimeZone();
  const labelFor = (index: number) => waypointLabels[index] ?? String(index + 1);

  const describeViolation = (violation: ScheduleViolation): string => {
    switch (violation.kind) {
      case "late-arrival":
        return t("scheduleLateArrival", {
          required: clockOf(violation.requiredBy),
          stop: labelFor(violation.waypointIndex),
          shortfall: formatDuration(violation.shortfallSeconds),
        });
      case "early-departure":
        return t("scheduleEarlyDeparture", {
          stop: labelFor(violation.waypointIndex),
          allowed: clockOf(violation.allowedFrom),
        });
      case "inverted-order":
        return t("scheduleInvertedOrder", {
          from: labelFor(violation.fromIndex),
          departure: clockOf(violation.earliestDeparture),
          to: labelFor(violation.toIndex),
          arrival: clockOf(violation.latestArrival),
        });
      case "anchor-conflict":
        return t("scheduleAnchorConflict", {
          anchor: clockOf(violation.anchor),
          stop: labelFor(violation.waypointIndex),
          arrival: clockOf(violation.latestArrival),
        });
      case "unreachable":
        return t("scheduleUnreachable", {
          from: labelFor(violation.fromIndex),
          to: labelFor(violation.toIndex),
        });
      default:
        return t("scheduleInvalidConstraint");
    }
  };

  const stopSeconds = schedule.totalDwellSeconds + schedule.totalWaitSeconds;

  return (
    <Box sx={{ px: 2, py: 1.5 }}>
      <Typography variant="subtitle2" sx={{ fontWeight: 600 }}>
        {t("scheduleTimeline")}
      </Typography>
      <Typography variant="caption" color="text.secondary" sx={{ display: "block", mb: 1 }}>
        {clockOf(schedule.departure)} – {clockOf(schedule.arrival)}
        {" · "}
        {t("scheduleTotals", {
          travel: formatDuration(schedule.totalTravelSeconds),
          stops: formatDuration(stopSeconds),
        })}
      </Typography>

      {schedule.stops.map((stop, position) => {
        const previous = schedule.stops[position - 1];
        const previousDate = previous
          ? dateOf(previous.departure ?? previous.arrival ?? schedule.departure)
          : null;
        const thisDate = dateOf(stop.arrival ?? stop.departure ?? schedule.departure);
        const showDivider = previousDate !== null && previousDate !== thisDate;

        return (
          <Fragment key={stop.waypointIndex}>
            {showDivider && (
              <Box
                data-testid="schedule-day-divider"
                sx={{
                  my: 0.75,
                  borderTop: "1px dashed",
                  borderColor: "divider",
                }}
              />
            )}
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 1, py: 0.25 }}>
              <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                {labelFor(stop.waypointIndex)}
              </Typography>
              {stop.timeZone !== localZone && (
                <Typography variant="caption" color="text.secondary">
                  {offsetLabel(stop.utcOffsetMinutes)}
                </Typography>
              )}
              <Typography variant="body2" sx={{ fontVariantNumeric: "tabular-nums" }}>
                {stop.arrival ? clockOf(stop.arrival) : ""}
                {stop.arrival && stop.departure ? " – " : ""}
                {stop.departure ? clockOf(stop.departure) : ""}
              </Typography>
            </Box>
            {(stop.dwellSeconds > 0 || stop.waitSeconds > 0) && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block", pl: 1 }}>
                {stop.dwellSeconds > 0 &&
                  t("scheduleStay", { duration: formatDuration(stop.dwellSeconds) })}
                {stop.dwellSeconds > 0 && stop.waitSeconds > 0 ? " · " : ""}
                {stop.waitSeconds > 0 &&
                  t("scheduleWait", { duration: formatDuration(stop.waitSeconds) })}
              </Typography>
            )}
          </Fragment>
        );
      })}

      {schedule.violations.length > 0 && (
        <Box role="alert" sx={{ mt: 1 }}>
          {schedule.violations.map((violation) => (
            <Typography
              key={`${violation.kind}-${JSON.stringify(violation)}`}
              variant="caption"
              color="error"
              sx={{ display: "block" }}
            >
              {describeViolation(violation)}
            </Typography>
          ))}
        </Box>
      )}

      {(fidelity === "approximate" ||
        warnings.some((warning) => warning.kind === "approximate-travel-times")) && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 1 }}>
          {t("scheduleApproximate")}
        </Typography>
      )}
    </Box>
  );
}
