"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { useTranslations } from "next-intl";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { type TransitTime, transitDelayMinutes } from "@/lib/transitTime";

const VISUALLY_HIDDEN = {
  position: "absolute",
  width: 1,
  height: 1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
} as const;

/** The same timetable, prediction and delay treatment on boards and journey timelines. */
export function DepartureTime({
  scheduledAt,
  expectedAt,
  canceled = false,
  variant = "body2",
  fontWeight = 500,
  muted = false,
}: TransitTime & {
  canceled?: boolean;
  variant?: "caption" | "body2" | "subtitle1";
  fontWeight?: number;
  muted?: boolean;
}) {
  const fmt = useDateTimeFormat();
  const t = useTranslations("transit");
  const tn = useTranslations("navigation");
  const scheduled =
    scheduledAt && Number.isFinite(Date.parse(scheduledAt)) ? fmt.time(scheduledAt) : undefined;
  const expected =
    expectedAt && Number.isFinite(Date.parse(expectedAt)) && !canceled
      ? fmt.time(expectedAt)
      : undefined;
  const changed = !!scheduled && !!expected && scheduled !== expected;
  const minutes = transitDelayMinutes({ scheduledAt, expectedAt });
  const delayed = !canceled && changed && minutes !== undefined && minutes > 0;
  if (!scheduled && !expected) return null;
  return (
    <Box
      component="span"
      sx={{
        display: "inline-flex",
        flexDirection: "column",
        alignItems: "flex-end",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
        verticalAlign: "top",
        color: muted ? "text.secondary" : "text.primary",
      }}
    >
      <Box component="span" sx={VISUALLY_HIDDEN}>
        {[
          scheduled ? `${t("scheduledTimeLabel", { time: scheduled })}.` : undefined,
          expected ? `${t("expectedTimeLabel", { time: expected })}.` : undefined,
        ]
          .filter(Boolean)
          .join(" ")}
      </Box>
      {scheduled && (
        <Typography
          component="span"
          aria-hidden
          variant={changed ? "caption" : variant}
          sx={{
            lineHeight: 1.4,
            fontWeight: changed ? 400 : fontWeight,
            textDecoration: canceled || changed ? "line-through" : "none",
            color: canceled ? "text.disabled" : changed ? "text.secondary" : "inherit",
          }}
        >
          {scheduled}
        </Typography>
      )}
      {expected && (changed || !scheduled) && (
        <Typography
          component="span"
          aria-hidden
          variant={variant}
          sx={{ lineHeight: 1.4, fontWeight, color: delayed ? "error.main" : "inherit" }}
        >
          {expected}
        </Typography>
      )}
      {delayed && (
        <Typography
          component="span"
          variant="caption"
          sx={{ lineHeight: 1.4, color: "error.main", fontWeight: 600 }}
        >
          {tn("delayMinutes", { minutes })}
        </Typography>
      )}
    </Box>
  );
}
