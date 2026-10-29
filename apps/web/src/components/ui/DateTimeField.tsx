"use client";

import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import IconButton from "@mui/material/IconButton";
import TextField from "@mui/material/TextField";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { ClockTimeField, nextFiveMinutes } from "./ClockTimeField";

const pad = (n: number) => String(n).padStart(2, "0");

function todayLocal(): string {
  const now = new Date();
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Splits a local `YYYY-MM-DDTHH:mm` value into its date and its time of day. */
function splitValue(value: string): {
  date: string;
  hours: number | null;
  minutes: number | null;
} {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(value);
  if (!match) return { date: "", hours: null, minutes: null };
  return { date: match[1] ?? "", hours: Number(match[2]), minutes: Number(match[3]) };
}

export interface DateTimeFieldProps {
  /** Local wall-clock `YYYY-MM-DDTHH:mm`, or "" when unset. */
  value: string;
  /** Receives a local `YYYY-MM-DDTHH:mm`, or "" when cleared. */
  onChange: (value: string) => void;
  /** Names the date and time pair for assistive technology. */
  label: string;
  /** Visible label of the date field; "Date" by default. */
  dateLabel?: string;
  /** Shows a button that clears the value. */
  clearable?: boolean;
  error?: boolean;
  disabled?: boolean;
  "aria-describedby"?: string;
  "data-testid"?: string;
}

/**
 * A date and a time of day, entered as the browser's date field next to the
 * clock-dial time field. It takes and gives the local wall-clock string a
 * `datetime-local` input would, so it can replace one directly.
 */
export function DateTimeField({
  value,
  onChange,
  label,
  dateLabel,
  clearable = false,
  error = false,
  disabled = false,
  "aria-describedby": describedBy,
  "data-testid": testId,
}: DateTimeFieldProps) {
  const t = useTranslations("timePicker");
  const tCommon = useTranslations("common");
  // The last value given out, so a time picked right after a date builds on that
  // date even while the owner's value (a server record, say) has not caught up.
  const [current, setCurrent] = useState(value);
  useEffect(() => setCurrent(value), [value]);
  const { date, hours, minutes } = splitValue(current);

  function change(next: string) {
    setCurrent(next);
    onChange(next);
  }

  function emit(nextDate: string, nextHours: number, nextMinutes: number) {
    change(`${nextDate}T${pad(nextHours)}:${pad(nextMinutes)}`);
  }

  return (
    <Box
      role="group"
      aria-label={label}
      aria-describedby={describedBy}
      data-testid={testId}
      sx={{ display: "flex", alignItems: "center", gap: 1, width: "100%" }}
    >
      <TextField
        size="small"
        type="date"
        label={dateLabel ?? t("date")}
        value={date}
        disabled={disabled}
        error={error}
        onChange={(e) => {
          const nextDate = e.target.value;
          if (!nextDate) {
            if (clearable) change("");
            return;
          }
          // A date picked before any time starts from the next five minutes.
          const time = hours === null || minutes === null ? nextFiveMinutes() : { hours, minutes };
          emit(nextDate, time.hours, time.minutes);
        }}
        slotProps={{ inputLabel: { shrink: true } }}
        sx={{ flex: 1, minWidth: 0 }}
      />
      <Box sx={{ flexShrink: 0 }}>
        <ClockTimeField
          label={t("time")}
          hours={hours}
          minutes={minutes}
          disabled={disabled}
          error={error}
          onChange={(nextHours, nextMinutes) => emit(date || todayLocal(), nextHours, nextMinutes)}
        />
      </Box>
      {clearable && current && (
        <IconButton
          size="small"
          aria-label={tCommon("clear")}
          disabled={disabled}
          onClick={() => change("")}
        >
          <CloseIcon fontSize="small" />
        </IconButton>
      )}
    </Box>
  );
}
