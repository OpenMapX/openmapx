"use client";

import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { deDE } from "@mui/x-date-pickers/locales";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import { renderTimeViewClock } from "@mui/x-date-pickers/timeViewRenderers";
import { type TimeFormat, useSettingsStore } from "@openmapx/core";
import dayjs, { type Dayjs } from "dayjs";
import "dayjs/locale/de";
import { useLocale } from "next-intl";
import { useMemo } from "react";

const PICKER_LOCALE_TEXT: Record<
  string,
  typeof deDE.components.MuiLocalizationProvider.defaultProps.localeText
> = {
  de: deDE.components.MuiLocalizationProvider.defaultProps.localeText,
};

/** Whether times should show AM/PM: the user's time-format setting, else the locale's own convention. */
export function usesTwelveHourClock(locale: string, timeFormat: TimeFormat | undefined): boolean {
  if (timeFormat === "12h") return true;
  if (timeFormat === "24h") return false;
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 === true;
}

export interface ClockTimeFieldProps {
  label: string;
  /** Time of day on the dial, 0..23. */
  hours: number;
  /** 0..59 */
  minutes: number;
  disabled: boolean;
  onChange: (hours: number, minutes: number) => void;
}

/**
 * A time-of-day field with an analog clock dial, like the Android time picker.
 * The field still accepts typed input; the dial opens in a popover on
 * pointer devices and in a dialog on touch devices.
 */
export function ClockTimeField({ label, hours, minutes, disabled, onChange }: ClockTimeFieldProps) {
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const ampm = usesTwelveHourClock(locale, timeFormat);
  const value = useMemo(() => dayjs().startOf("day").hour(hours).minute(minutes), [hours, minutes]);

  function handleChange(next: Dayjs | null) {
    // A partly typed time has no valid value yet; keep the last complete one.
    if (!next?.isValid()) return;
    if (next.hour() === hours && next.minute() === minutes) return;
    onChange(next.hour(), next.minute());
  }

  return (
    <LocalizationProvider
      dateAdapter={AdapterDayjs}
      adapterLocale={locale}
      localeText={PICKER_LOCALE_TEXT[locale]}
    >
      <TimePicker
        label={label}
        value={value}
        disabled={disabled}
        ampm={ampm}
        views={["hours", "minutes"]}
        viewRenderers={{ hours: renderTimeViewClock, minutes: renderTimeViewClock }}
        onChange={handleChange}
        slotProps={{ textField: { size: "small", sx: { maxWidth: ampm ? 160 : 140 } } }}
      />
    </LocalizationProvider>
  );
}
