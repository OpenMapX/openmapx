"use client";

import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import TodayIcon from "@mui/icons-material/Today";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useLocale, useTranslations } from "next-intl";

interface TimelineDayHeaderProps {
  date: string;
  today: string;
  timeZone: string;
  browserTimeZone: string;
  onDateChange: (date: string) => void;
}

export function calendarDateInTimeZone(value: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((candidate) => candidate.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

export function offsetCalendarDate(date: string, days: number): string {
  const [year, month, day] = date.split("-").map(Number);
  const value = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, (day ?? 1) + days));
  return value.toISOString().slice(0, 10);
}

export function TimelineDayHeader({
  date,
  today,
  timeZone,
  browserTimeZone,
  onDateChange,
}: TimelineDayHeaderProps) {
  const t = useTranslations("timeline");
  const locale = useLocale();
  const title = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${date}T12:00:00.000Z`));
  const isToday = date >= today;

  return (
    <Box component="header" sx={{ mb: 2 }}>
      <Typography
        component="h1"
        variant="h6"
        sx={{ fontWeight: 650, letterSpacing: "-0.012em", lineHeight: 1.25, mb: 1.25 }}
      >
        {title}
      </Typography>
      <Box sx={{ display: "flex", gap: 0.75, alignItems: "center", flexWrap: "wrap" }}>
        <IconButton
          aria-label={t("previousDay")}
          onClick={() => onDateChange(offsetCalendarDate(date, -1))}
          sx={{ width: 44, height: 44 }}
        >
          <ChevronLeftIcon />
        </IconButton>
        <TextField
          type="date"
          size="small"
          label={t("datePicker")}
          value={date}
          onChange={(event) => {
            const next = event.target.value;
            if (/^\d{4}-\d{2}-\d{2}$/.test(next) && next <= today) onDateChange(next);
          }}
          slotProps={{ htmlInput: { max: today } }}
          sx={{ flex: "1 1 150px", minWidth: 0, "& .MuiInputBase-root": { minHeight: 44 } }}
        />
        <IconButton
          aria-label={t("nextDay")}
          disabled={isToday}
          onClick={() => onDateChange(offsetCalendarDate(date, 1))}
          sx={{ width: 44, height: 44 }}
        >
          <ChevronRightIcon />
        </IconButton>
        <Button
          startIcon={<TodayIcon />}
          onClick={() => onDateChange(today)}
          disabled={isToday}
          sx={{ minHeight: 44 }}
        >
          {t("today")}
        </Button>
      </Box>
      {timeZone !== browserTimeZone && (
        <Typography variant="caption" color="text.secondary" sx={{ display: "block", mt: 0.75 }}>
          {t("timezoneLabel")} <span dir="ltr">{timeZone}</span>
        </Typography>
      )}
    </Box>
  );
}
