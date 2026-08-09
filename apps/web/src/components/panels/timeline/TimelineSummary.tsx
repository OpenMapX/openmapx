"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { PersonalTimelineDayV1 } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";

interface TimelineSummaryProps {
  summary: PersonalTimelineDayV1["summary"];
  distanceUnit: string;
}

export function TimelineSummary({ summary, distanceUnit }: TimelineSummaryProps) {
  const t = useTranslations("timeline.summary");
  const locale = useLocale();
  const number = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  const integer = new Intl.NumberFormat(locale, { maximumFractionDigits: 0 });
  const minutes = new Intl.NumberFormat(locale, {
    style: "unit",
    unit: "minute",
    unitDisplay: "short",
    maximumFractionDigits: 0,
  });
  const items = [
    { label: t("distance"), value: `${number.format(summary.totalDistance)} ${distanceUnit}` },
    { label: t("places"), value: integer.format(summary.placesVisited) },
    { label: t("moving"), value: minutes.format(summary.movingMinutes) },
    { label: t("stationary"), value: minutes.format(summary.stationaryMinutes) },
  ];

  return (
    <Box
      component="dl"
      sx={{
        display: "grid",
        gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
        gap: 1,
        m: 0,
        mb: 2,
      }}
    >
      {items.map((item) => (
        <Box
          key={item.label}
          sx={{ p: 1.25, borderRadius: 2, bgcolor: "action.hover", minWidth: 0 }}
        >
          <Typography component="dd" variant="subtitle2" sx={{ m: 0, fontWeight: 700 }}>
            {item.value}
          </Typography>
          <Typography component="dt" variant="caption" color="text.secondary">
            {item.label}
          </Typography>
        </Box>
      ))}
    </Box>
  );
}
