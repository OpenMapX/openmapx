"use client";

import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Typography from "@mui/material/Typography";
import type { ChainedTripPlan, ChainPlanWarning } from "@openmapx/core";
import { formatDuration } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { Fragment } from "react";
import { TransitItineraryCard } from "@/components/panels/directions/TransitRouteView";
import { TripScheduleCard } from "@/components/panels/directions/TripScheduleCard";

/** Stable identity for a warning: its kind plus the segment it points at. */
function warningKey(warning: ChainPlanWarning): string {
  return `${warning.kind}-${warningSegment(warning) ?? "trip"}`;
}

/** Which segment a warning belongs under, or null for a whole-chain warning. */
function warningSegment(warning: ChainPlanWarning): number | null {
  switch (warning.kind) {
    case "missed-connection":
      return warning.afterSegmentIndex;
    case "cancelled-leg":
    case "unmet-requirement":
    case "no-connection":
      return warning.segmentIndex;
    default:
      return null;
  }
}

export interface TransitChainViewProps {
  plan: ChainedTripPlan;
  waypointLabels: string[];
  onSegmentDetails?: (segmentIndex: number) => void;
}

export function TransitChainView({
  plan,
  waypointLabels,
  onSegmentDetails,
}: TransitChainViewProps) {
  const t = useTranslations("directions");
  const labelFor = (index: number) => waypointLabels[index] ?? String(index + 1);

  const messageFor = (warning: ChainPlanWarning): string => {
    switch (warning.kind) {
      case "missed-connection":
        return t("chainMissedConnection");
      case "cancelled-leg":
        return t("chainCancelledLeg");
      case "unmet-requirement":
        return t("chainUnmetRequirement");
      default:
        return t("chainNoConnection");
    }
  };

  return (
    <Box>
      <TripScheduleCard
        schedule={plan.schedule}
        fidelity={plan.fidelity}
        warnings={[]}
        waypointLabels={waypointLabels}
      />
      <Divider />
      {plan.segments.map((segment, index) => (
        <Fragment key={`${segment.fromIndex}-${segment.toIndex}`}>
          <Box sx={{ px: 2, pt: 1.5 }}>
            <Typography variant="caption" color="text.secondary">
              {t("chainSegment", {
                index: String(index + 1),
                total: String(plan.segments.length),
              })}
              {" · "}
              {labelFor(segment.fromIndex)} – {labelFor(segment.toIndex)}
            </Typography>
            {segment.boardingWaitSeconds > 0 && (
              <Typography variant="caption" color="text.secondary" sx={{ display: "block" }}>
                {t("chainBoardingWait", {
                  duration: formatDuration(segment.boardingWaitSeconds),
                })}
              </Typography>
            )}
            {segment.delaySeconds > 0 && (
              <Typography variant="caption" color="error" sx={{ display: "block" }}>
                {t("chainDelay", { delay: formatDuration(segment.delaySeconds) })}
              </Typography>
            )}
          </Box>
          <TransitItineraryCard
            itinerary={segment.itinerary}
            active
            onSelect={() => undefined}
            onDetails={() => onSegmentDetails?.(index)}
          />
          {plan.warnings
            .filter((warning) => warningSegment(warning) === index)
            .map((warning) => (
              <Typography
                key={warningKey(warning)}
                role="alert"
                variant="caption"
                color="error"
                sx={{ display: "block", px: 2, pb: 1 }}
              >
                {messageFor(warning)}
              </Typography>
            ))}
          {index < plan.segments.length - 1 && <Divider />}
        </Fragment>
      ))}
      {plan.warnings
        .filter((warning) => warningSegment(warning) === plan.segments.length)
        .map((warning) => (
          <Typography
            key={warningKey(warning)}
            role="alert"
            variant="caption"
            color="error"
            sx={{ display: "block", px: 2, py: 1 }}
          >
            {messageFor(warning)}
          </Typography>
        ))}
    </Box>
  );
}
