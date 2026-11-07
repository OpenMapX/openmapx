"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Typography from "@mui/material/Typography";
import type { TransitProgress } from "@openmapx/core";
import { selectStopPlatform } from "@openmapx/mobility-core/platform";
import type { TripLeg, VehicleJourneyStop } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { type ReactNode, useEffect, useId, useState } from "react";
import { DepartureTime } from "@/components/panels/transit/DepartureTime";
import { PlatformBadge } from "@/components/panels/transit/PlatformBadge";
import { legTransitTime, stopTransitTime } from "@/lib/transitTime";

const TIME_COLUMN_WIDTH = "4.3125rem";

/** A disclosure never hides disruptions. Its control survives cursor updates to retain focus. */
function StopGroup({
  indices,
  stops,
  kind,
  collapsible,
  renderStop,
}: {
  indices: number[];
  stops: VehicleJourneyStop[];
  kind: "previous" | "intermediate";
  collapsible: boolean;
  renderStop: (index: number) => ReactNode;
}) {
  const t = useTranslations("navigation");
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const [wasAvailable, setWasAvailable] = useState(false);
  const ordinary = indices.filter((i) => !stops[i].canceled && !stops[i].alerts?.length);
  const available = collapsible && ordinary.length >= 2;
  useEffect(() => {
    if (available) setWasAvailable(true);
  }, [available]);
  const open = !available || expanded;
  return (
    <Box
      sx={{
        position: "relative",
        "&::before": {
          content: '""',
          position: "absolute",
          left: `calc(${TIME_COLUMN_WIDTH} + 17px)`,
          top: 0,
          bottom: 0,
          width: 2,
          bgcolor: "divider",
        },
      }}
    >
      {(available || wasAvailable) && (
        <Button
          aria-expanded={open}
          aria-controls={id}
          aria-disabled={!available || undefined}
          onClick={() => {
            if (available) setExpanded((value) => !value);
          }}
          startIcon={
            open ? (
              <ExpandLessIcon sx={{ bgcolor: "background.paper", position: "relative" }} />
            ) : (
              <ExpandMoreIcon sx={{ bgcolor: "background.paper", position: "relative" }} />
            )
          }
          sx={{
            minHeight: 44,
            ml: `calc(${TIME_COLUMN_WIDTH} + 4px)`,
            px: 1,
            justifyContent: "flex-start",
            color: "text.secondary",
            textAlign: "left",
            "&:focus-visible": {
              outline: "2px solid",
              outlineColor: "primary.main",
              outlineOffset: -2,
            },
          }}
        >
          {t(
            !available
              ? "allStopsShown"
              : kind === "previous"
                ? open
                  ? "hidePreviousStops"
                  : "showPreviousStops"
                : open
                  ? "hideIntermediateStops"
                  : "showIntermediateStops",
            { count: ordinary.length },
          )}
        </Button>
      )}
      <Box id={id}>
        {indices.map((i) =>
          open || stops[i].canceled || stops[i].alerts?.length ? renderStop(i) : null,
        )}
      </Box>
    </Box>
  );
}

/** The session's captured stops, with a conservative view when GPS confidence is missing. */
export function TransitStopTimeline({
  stops,
  leg,
  progress,
}: {
  stops: VehicleJourneyStop[];
  leg: TripLeg;
  progress: TransitProgress | null;
}) {
  const t = useTranslations("navigation");
  const riding = progress?.phase === "riding";
  const cursor = riding ? Math.max(0, Math.min(progress.stopCursor ?? 1, stops.length - 1)) : 0;
  const confident = riding && progress?.confidence === "gps";
  const last = stops.length - 1;
  const previous = riding
    ? stops.map((_, i) => i).filter((i) => i > 0 && i < cursor && i < last)
    : [];
  const future = stops.map((_, i) => i).filter((i) => i > cursor && i < last);
  const renderStop = (i: number) => {
    const stop = stops[i];
    const first = i === 0;
    const final = i === last;
    const next = confident && i === cursor;
    const passed = riding && i < cursor;
    const emphasized = first || final || next;
    const platform = selectStopPlatform(stop, final ? "arrival" : "departure");
    const time = first
      ? legTransitTime(leg, "departure", stop)
      : final
        ? legTransitTime(leg, "arrival", stop)
        : stopTransitTime(stop);
    const dotColor = next ? "primary.main" : "text.secondary";
    return (
      <Box key={i} sx={{ display: "flex", gap: 1.25, alignItems: "stretch" }}>
        <Box
          sx={{
            width: TIME_COLUMN_WIDTH,
            fontSize: ".75rem",
            textAlign: "right",
            flexShrink: 0,
            pt: 0.75,
          }}
        >
          <DepartureTime
            {...time}
            canceled={stop.canceled}
            variant="caption"
            fontWeight={emphasized ? 700 : 400}
            muted={passed}
          />
        </Box>
        <Box
          sx={{
            position: "relative",
            width: 16,
            flexShrink: 0,
            display: "flex",
            justifyContent: "center",
          }}
        >
          <Box
            sx={{
              position: "absolute",
              width: 2,
              bgcolor: "divider",
              top: first ? 14 : 0,
              bottom: final ? "calc(100% - 14px)" : 0,
            }}
          />
          <Box
            sx={{
              position: "absolute",
              top: 10,
              width: next ? 12 : 10,
              height: next ? 12 : 10,
              borderRadius: "50%",
              border: "2px solid",
              borderColor: dotColor,
              bgcolor: next ? "primary.main" : "background.paper",
            }}
          />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0, pt: 0.5, pb: 1.75 }}>
          {(first || final || next) && (
            <Typography
              variant="caption"
              color={next ? "primary.main" : "text.secondary"}
              sx={{ display: "block", fontWeight: next ? 600 : 400 }}
            >
              {t(next ? "nextStopLabel" : first ? "boardingStopLabel" : "alightingStopLabel")}
            </Typography>
          )}
          <Typography
            variant="body2"
            sx={{
              overflowWrap: "anywhere",
              lineHeight: 1.5,
              fontWeight: emphasized ? 600 : 400,
              textDecoration: stop.canceled ? "line-through" : undefined,
              color: stop.canceled ? "error.main" : passed ? "text.secondary" : "text.primary",
            }}
          >
            {stop.name}
          </Typography>
          {stop.canceled && (
            <Typography variant="caption" color="error.main" sx={{ fontWeight: 600 }}>
              {t("stopSkipped")}
            </Typography>
          )}
          {stop.alerts?.map((alert) => (
            <Box
              key={alert.id}
              sx={{ display: "flex", alignItems: "flex-start", gap: 0.5, mt: 0.5 }}
            >
              <WarningAmberIcon
                sx={{ fontSize: 16, color: "warning.main", mt: 0.1, flexShrink: 0 }}
              />
              <Typography variant="caption" sx={{ overflowWrap: "anywhere" }}>
                {alert.title}
              </Typography>
            </Box>
          ))}
          {platform.code && !stop.canceled && (
            <Box sx={{ mt: 0.5 }}>
              <PlatformBadge code={platform.code} scheduledCode={platform.scheduledCode} />
            </Box>
          )}
        </Box>
      </Box>
    );
  };
  return (
    <Box sx={{ px: 2, py: 0.5 }}>
      {stops.length > 0 && renderStop(0)}
      <StopGroup
        indices={previous}
        stops={stops}
        kind="previous"
        collapsible
        renderStop={renderStop}
      />
      {riding && cursor > 0 && cursor < last && renderStop(cursor)}
      <StopGroup
        indices={future}
        stops={stops}
        kind="intermediate"
        collapsible={(!riding || confident) && stops.length > 4}
        renderStop={renderStop}
      />
      {last > 0 && renderStop(last)}
    </Box>
  );
}
