"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import DirectionsTransitIcon from "@mui/icons-material/DirectionsTransit";
import DirectionsWalkIcon from "@mui/icons-material/DirectionsWalk";
import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Typography from "@mui/material/Typography";
import type { TripLeg } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useId } from "react";
import { RouteBadge } from "@/components/panels/transit/RouteBadge";

/** One details control, with a bounded preview of the remaining selected journey. */
export function TransitJourneyToolbar({
  legs,
  currentLegIndex,
  expanded,
  onToggle,
  mobile = false,
}: {
  legs: TripLeg[];
  currentLegIndex: number;
  expanded: boolean;
  onToggle: () => void;
  mobile?: boolean;
}) {
  const t = useTranslations("navigation");
  const previewId = useId();
  const remaining = legs.slice(Math.max(0, currentLegIndex));
  const preview = remaining.slice(0, 3);
  return (
    <ButtonBase
      type="button"
      onClick={onToggle}
      aria-label={t(mobile ? "resizePanel" : "moreOptions")}
      aria-describedby={previewId}
      aria-expanded={expanded}
      aria-controls="transit-journey-details"
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        width: 1,
        minHeight: 44,
        px: 2,
        pt: mobile ? 1 : 1.25,
        pb: 1.25,
        color: "text.primary",
        borderBottom: "1px solid",
        borderColor: "divider",
        "&:focus-visible": {
          outline: "2px solid",
          outlineColor: "primary.main",
          outlineOffset: -2,
        },
      }}
    >
      {mobile && (
        <Box
          aria-hidden
          sx={{
            width: 32,
            height: 4,
            borderRadius: "999px",
            bgcolor: "action.disabled",
            alignSelf: "center",
            mb: 1,
          }}
        />
      )}
      <Box sx={{ display: "flex", alignItems: "center", gap: 1, minWidth: 0, minHeight: 32 }}>
        <Box
          id={previewId}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            minWidth: 0,
            overflow: "hidden",
            flex: 1,
          }}
        >
          {preview.map((leg, i) => (
            <Box
              key={`${leg.tripId ?? leg.mode}:${leg.startTime}:${leg.from.name}:${leg.to.name}`}
              sx={{ display: "flex", alignItems: "center", gap: 0.75, minWidth: 0, flexShrink: 0 }}
            >
              {i > 0 && <ChevronRightIcon sx={{ fontSize: 16, color: "text.secondary" }} />}
              {leg.mode === "walking" ? (
                <DirectionsWalkIcon sx={{ fontSize: 20, color: "text.secondary" }} />
              ) : leg.route ? (
                <RouteBadge
                  shortName={leg.route.shortName || leg.route.longName || ""}
                  mode={leg.mode}
                  color={leg.route.color}
                  textColor={leg.route.textColor}
                />
              ) : (
                <DirectionsTransitIcon sx={{ fontSize: 20 }} />
              )}
            </Box>
          ))}
          {remaining.length > preview.length && (
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              {t("moreJourneyLegs", { count: remaining.length - preview.length })}
            </Typography>
          )}
        </Box>
        {expanded ? <ExpandMoreIcon /> : <ExpandLessIcon />}
      </Box>
    </ButtonBase>
  );
}
