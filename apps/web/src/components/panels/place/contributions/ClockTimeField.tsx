"use client";

import KeyboardOutlinedIcon from "@mui/icons-material/KeyboardOutlined";
import ScheduleOutlinedIcon from "@mui/icons-material/ScheduleOutlined";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import ButtonBase from "@mui/material/ButtonBase";
import Dialog from "@mui/material/Dialog";
import IconButton from "@mui/material/IconButton";
import InputAdornment from "@mui/material/InputAdornment";
import InputBase from "@mui/material/InputBase";
import type { Theme } from "@mui/material/styles";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { type TimeFormat, useSettingsStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { type KeyboardEvent, type PointerEvent, useId, useRef, useState } from "react";

/** Whether times should show AM/PM: the user's time-format setting, else the locale's own convention. */
export function usesTwelveHourClock(locale: string, timeFormat: TimeFormat | undefined): boolean {
  if (timeFormat === "12h") return true;
  if (timeFormat === "24h") return false;
  return new Intl.DateTimeFormat(locale, { hour: "numeric" }).resolvedOptions().hour12 === true;
}

function formatTime(locale: string, ampm: boolean, hours: number, minutes: number): string {
  return new Intl.DateTimeFormat(locale, {
    hour: ampm ? "numeric" : "2-digit",
    minute: "2-digit",
    hour12: ampm,
    timeZone: "UTC",
  }).format(Date.UTC(2000, 0, 1, hours, minutes));
}

function dayPeriodLabel(locale: string, hours: number): string {
  const parts = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    hour12: true,
    timeZone: "UTC",
  }).formatToParts(Date.UTC(2000, 0, 1, hours));
  return parts.find((p) => p.type === "dayPeriod")?.value ?? (hours < 12 ? "AM" : "PM");
}

const pad = (n: number) => String(n).padStart(2, "0");

const tonal = (theme: Theme, color: "primary" | "secondary" | "text", amount: number) =>
  theme.alpha(
    color === "text"
      ? (theme.vars ?? theme).palette.text.primary
      : (theme.vars ?? theme).palette[color].main,
    amount,
  );

// Dial geometry in CSS pixels, after the Material 3 time picker.
const DIAL = 256;
const CENTER = DIAL / 2;
const HANDLE = 48;
const OUTER_RADIUS = 104;
const INNER_RADIUS = 68;

type View = "hours" | "minutes";

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
 * A time-of-day field that opens the Material 3 time picker: a clock dial
 * with a text-input mode, as in Android's own time picker.
 */
export function ClockTimeField({ label, hours, minutes, disabled, onChange }: ClockTimeFieldProps) {
  const t = useTranslations("osmContributions");
  const locale = useLocale();
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const ampm = usesTwelveHourClock(locale, timeFormat);
  const [open, setOpen] = useState(false);
  const formatted = formatTime(locale, ampm, hours, minutes);

  return (
    <>
      <TextField
        size="small"
        label={label}
        value={formatted}
        disabled={disabled}
        onClick={() => !disabled && setOpen(true)}
        onKeyDown={(e) => {
          if (!disabled && (e.key === "Enter" || e.key === " " || e.key === "ArrowDown")) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        sx={{ maxWidth: ampm ? 150 : 130, "& input": { cursor: disabled ? undefined : "pointer" } }}
        slotProps={{
          htmlInput: {
            readOnly: true,
            "aria-haspopup": "dialog",
            "aria-label": t("ohTimePickerOpen", { time: formatted }),
          },
          input: {
            endAdornment: (
              <InputAdornment position="end" sx={{ pointerEvents: "none" }}>
                <ScheduleOutlinedIcon fontSize="small" />
              </InputAdornment>
            ),
          },
        }}
      />
      {open && (
        <TimePickerDialog
          hours={hours}
          minutes={minutes}
          ampm={ampm}
          locale={locale}
          onCancel={() => setOpen(false)}
          onConfirm={(h, m) => {
            setOpen(false);
            if (h !== hours || m !== minutes) onChange(h, m);
          }}
        />
      )}
    </>
  );
}

interface TimePickerDialogProps {
  hours: number;
  minutes: number;
  ampm: boolean;
  locale: string;
  onCancel: () => void;
  onConfirm: (hours: number, minutes: number) => void;
}

function TimePickerDialog({
  hours,
  minutes,
  ampm,
  locale,
  onCancel,
  onConfirm,
}: TimePickerDialogProps) {
  const t = useTranslations("osmContributions");
  const titleId = useId();
  const [draftHours, setDraftHours] = useState(hours);
  const [draftMinutes, setDraftMinutes] = useState(minutes);
  const [view, setView] = useState<View>("hours");
  const [mode, setMode] = useState<"dial" | "keyboard">("dial");
  const [hourText, setHourText] = useState("");
  const [minuteText, setMinuteText] = useState("");

  const displayHours = ampm ? draftHours % 12 || 12 : draftHours;
  const isPm = draftHours >= 12;

  const hourValid =
    /^\d{1,2}$/.test(hourText) &&
    (ampm ? Number(hourText) >= 1 && Number(hourText) <= 12 : Number(hourText) <= 23);
  const minuteValid = /^\d{1,2}$/.test(minuteText) && Number(minuteText) <= 59;

  function parsedKeyboardTime(): { hours: number; minutes: number } | null {
    if (!hourValid || !minuteValid) return null;
    const h = Number(hourText);
    return { hours: ampm ? (h % 12) + (isPm ? 12 : 0) : h, minutes: Number(minuteText) };
  }

  function switchMode() {
    if (mode === "dial") {
      setHourText(ampm ? String(displayHours) : pad(draftHours));
      setMinuteText(pad(draftMinutes));
      setMode("keyboard");
      return;
    }
    const parsed = parsedKeyboardTime();
    if (parsed) {
      setDraftHours(parsed.hours);
      setDraftMinutes(parsed.minutes);
    }
    setMode("dial");
  }

  function setPeriod(pm: boolean) {
    if (pm !== isPm) setDraftHours((draftHours + 12) % 24);
  }

  const keyboardTime = mode === "keyboard" ? parsedKeyboardTime() : null;
  const canConfirm = mode === "dial" || keyboardTime !== null;

  function confirm() {
    if (mode === "keyboard") {
      if (keyboardTime) onConfirm(keyboardTime.hours, keyboardTime.minutes);
      return;
    }
    onConfirm(draftHours, draftMinutes);
  }

  return (
    <Dialog
      open
      onClose={onCancel}
      aria-labelledby={titleId}
      maxWidth={false}
      slotProps={{
        paper: {
          sx: {
            borderRadius: "28px",
            p: 3,
            pb: 1.5,
            m: 2,
            width: 328,
            maxWidth: "calc(100vw - 32px)",
            backgroundImage: "none",
          },
        },
      }}
    >
      <Typography
        id={titleId}
        variant="caption"
        sx={{ color: "text.secondary", fontWeight: 500, letterSpacing: 0.5, mb: 2.5 }}
      >
        {mode === "dial" ? t("ohTimePickerSelect") : t("ohTimePickerEnter")}
      </Typography>

      <Box sx={{ display: "flex", alignItems: "flex-start", justifyContent: "center", gap: 1.5 }}>
        <Box sx={{ display: "flex", alignItems: "flex-start" }}>
          {mode === "dial" ? (
            <>
              <TimeSegment
                value={pad(displayHours)}
                selected={view === "hours"}
                label={t("ohTimePickerHours")}
                onClick={() => setView("hours")}
              />
              <Separator />
              <TimeSegment
                value={pad(draftMinutes)}
                selected={view === "minutes"}
                label={t("ohTimePickerMinutes")}
                onClick={() => setView("minutes")}
              />
            </>
          ) : (
            <>
              <TimeInput
                value={hourText}
                label={t("ohTimePickerHour")}
                autoFocus
                invalid={hourText !== "" && !hourValid}
                onChange={setHourText}
                onEnter={confirm}
              />
              <Separator />
              <TimeInput
                value={minuteText}
                label={t("ohTimePickerMinute")}
                invalid={minuteText !== "" && !minuteValid}
                onChange={setMinuteText}
                onEnter={confirm}
              />
            </>
          )}
        </Box>
        {ampm && (
          <PeriodSelector
            amLabel={dayPeriodLabel(locale, 0)}
            pmLabel={dayPeriodLabel(locale, 12)}
            pm={isPm}
            height={mode === "dial" ? 80 : 72}
            onChange={setPeriod}
          />
        )}
      </Box>

      {mode === "dial" && (
        <Box sx={{ display: "flex", justifyContent: "center", mt: 4.5 }}>
          <TimeDial
            view={view}
            hours={draftHours}
            minutes={draftMinutes}
            ampm={ampm}
            label={view === "hours" ? t("ohTimePickerHours") : t("ohTimePickerMinutes")}
            onHoursChange={setDraftHours}
            onMinutesChange={setDraftMinutes}
            onHoursSettled={() => setView("minutes")}
          />
        </Box>
      )}

      <Box sx={{ display: "flex", alignItems: "center", mt: 3 }}>
        <IconButton
          onClick={switchMode}
          aria-label={mode === "dial" ? t("ohTimePickerToKeyboard") : t("ohTimePickerToDial")}
          sx={{ ml: -1, color: "text.secondary" }}
        >
          {mode === "dial" ? <KeyboardOutlinedIcon /> : <ScheduleOutlinedIcon />}
        </IconButton>
        <Box sx={{ flex: 1 }} />
        <Button onClick={onCancel}>{t("cancel")}</Button>
        <Button onClick={confirm} disabled={!canConfirm}>
          {t("ohTimePickerOk")}
        </Button>
      </Box>
    </Dialog>
  );
}

function Separator() {
  return (
    <Box
      aria-hidden
      sx={{
        width: 24,
        height: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        fontSize: 57,
        lineHeight: 1,
        color: "text.primary",
      }}
    >
      :
    </Box>
  );
}

const segmentSx = (selected: boolean) => (theme: Theme) => ({
  width: 96,
  borderRadius: "8px",
  fontSize: 57,
  lineHeight: "64px",
  fontWeight: 400,
  fontVariantNumeric: "tabular-nums",
  color: selected
    ? (theme.vars ?? theme).palette.primary.main
    : (theme.vars ?? theme).palette.text.primary,
  bgcolor: selected ? tonal(theme, "primary", 0.16) : tonal(theme, "text", 0.07),
});

function TimeSegment({
  value,
  selected,
  label,
  onClick,
}: {
  value: string;
  selected: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <ButtonBase
      onClick={onClick}
      aria-label={`${label} ${value}`}
      aria-pressed={selected}
      sx={[segmentSx(selected), { height: 80, fontFamily: "inherit" }]}
    >
      {value}
    </ButtonBase>
  );
}

function TimeInput({
  value,
  label,
  autoFocus,
  invalid,
  onChange,
  onEnter,
}: {
  value: string;
  label: string;
  autoFocus?: boolean;
  invalid: boolean;
  onChange: (value: string) => void;
  onEnter: () => void;
}) {
  return (
    <Box>
      <InputBase
        value={value}
        autoFocus={autoFocus}
        onChange={(e) => onChange(e.target.value.replace(/\D/g, "").slice(0, 2))}
        onFocus={(e) => e.target.select()}
        onKeyDown={(e) => e.key === "Enter" && onEnter()}
        inputProps={{ inputMode: "numeric", "aria-label": label, "aria-invalid": invalid }}
        sx={(theme) => ({
          ...segmentSx(false)(theme),
          height: 72,
          fontSize: 45,
          lineHeight: "52px",
          border: "2px solid transparent",
          "&.Mui-focused": {
            color: (theme.vars ?? theme).palette.primary.main,
            borderColor: (theme.vars ?? theme).palette.primary.main,
            bgcolor: tonal(theme, "primary", 0.16),
          },
          ...(invalid && { borderColor: (theme.vars ?? theme).palette.error.main }),
          "& input": { textAlign: "center", p: 0, height: "100%" },
        })}
      />
      <Typography variant="caption" component="div" sx={{ color: "text.secondary", mt: 0.75 }}>
        {label}
      </Typography>
    </Box>
  );
}

function PeriodSelector({
  amLabel,
  pmLabel,
  pm,
  height,
  onChange,
}: {
  amLabel: string;
  pmLabel: string;
  pm: boolean;
  height: number;
  onChange: (pm: boolean) => void;
}) {
  const option = (selected: boolean, text: string, value: boolean) => (
    <ButtonBase
      onClick={() => onChange(value)}
      aria-pressed={selected}
      sx={(theme) => ({
        flex: 1,
        width: "100%",
        fontFamily: "inherit",
        fontSize: 15,
        fontWeight: 500,
        color: selected
          ? (theme.vars ?? theme).palette.secondary.main
          : (theme.vars ?? theme).palette.text.secondary,
        bgcolor: selected ? tonal(theme, "secondary", 0.18) : "transparent",
      })}
    >
      {text}
    </ButtonBase>
  );
  return (
    <Box
      sx={{
        width: 52,
        height,
        display: "flex",
        flexDirection: "column",
        border: 1,
        borderColor: "divider",
        borderRadius: "8px",
        overflow: "hidden",
        "& > :first-of-type": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      {option(!pm, amLabel, false)}
      {option(pm, pmLabel, true)}
    </Box>
  );
}

interface TimeDialProps {
  view: View;
  hours: number;
  minutes: number;
  ampm: boolean;
  label: string;
  onHoursChange: (hours: number) => void;
  onMinutesChange: (minutes: number) => void;
  onHoursSettled: () => void;
}

function polar(radius: number, step: number, steps: number) {
  const angle = (step / steps) * 2 * Math.PI;
  return { x: CENTER + radius * Math.sin(angle), y: CENTER - radius * Math.cos(angle) };
}

function TimeDial({
  view,
  hours,
  minutes,
  ampm,
  label,
  onHoursChange,
  onMinutesChange,
  onHoursSettled,
}: TimeDialProps) {
  const dialRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // In 24-hour mode the outer ring holds 0–11 and the inner ring 12–23.
  const handleOnInnerRing = view === "hours" && !ampm && hours >= 12;
  const handleRadius = handleOnInnerRing ? INNER_RADIUS : OUTER_RADIUS;
  const handleStep = view === "hours" ? hours % 12 : minutes;
  const handleSteps = view === "hours" ? 12 : 60;
  const handle = polar(handleRadius, handleStep, handleSteps);
  const handleAngle = (handleStep / handleSteps) * 360;

  const labels =
    view === "hours"
      ? [
          ...Array.from({ length: 12 }, (_, i) => ({
            value: ampm ? i || 12 : i,
            text: String(ampm ? i || 12 : i),
            ...polar(OUTER_RADIUS, i, 12),
            inner: false,
          })),
          ...(ampm
            ? []
            : Array.from({ length: 12 }, (_, i) => ({
                value: i + 12,
                text: String(i + 12),
                ...polar(INNER_RADIUS, i, 12),
                inner: true,
              }))),
        ]
      : Array.from({ length: 12 }, (_, i) => ({
          value: i * 5,
          text: pad(i * 5),
          ...polar(OUTER_RADIUS, i, 12),
          inner: false,
        }));

  const selectedLabel = (value: number) =>
    view === "hours" ? (ampm ? (hours % 12 || 12) === value : hours === value) : minutes === value;

  function pick(clientX: number, clientY: number) {
    const rect = dialRef.current?.getBoundingClientRect();
    if (!rect) return;
    const scale = DIAL / rect.width;
    const x = (clientX - rect.left) * scale - CENTER;
    const y = (clientY - rect.top) * scale - CENTER;
    const degrees = ((Math.atan2(x, -y) * 180) / Math.PI + 360) % 360;
    if (view === "minutes") {
      onMinutesChange(Math.round(degrees / 6) % 60);
      return;
    }
    const step = Math.round(degrees / 30) % 12;
    if (ampm) {
      onHoursChange(step + (hours >= 12 ? 12 : 0));
    } else {
      const inner = Math.hypot(x, y) < (OUTER_RADIUS + INNER_RADIUS) / 2;
      onHoursChange(step + (inner ? 12 : 0));
    }
  }

  function handlePointerDown(e: PointerEvent<HTMLDivElement>) {
    dragging.current = true;
    e.currentTarget.setPointerCapture(e.pointerId);
    dialRef.current?.focus();
    pick(e.clientX, e.clientY);
  }

  function handlePointerUp() {
    if (!dragging.current) return;
    dragging.current = false;
    if (view === "hours") onHoursSettled();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    const delta =
      e.key === "ArrowUp" || e.key === "ArrowRight"
        ? 1
        : e.key === "ArrowDown" || e.key === "ArrowLeft"
          ? -1
          : 0;
    if (delta === 0) return;
    e.preventDefault();
    if (view === "hours") onHoursChange((hours + delta + 24) % 24);
    else onMinutesChange((minutes + delta + 60) % 60);
  }

  return (
    <Box
      ref={dialRef}
      role="slider"
      tabIndex={0}
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={view === "hours" ? 23 : 59}
      aria-valuenow={view === "hours" ? hours : minutes}
      onPointerDown={handlePointerDown}
      onPointerMove={(e) => dragging.current && pick(e.clientX, e.clientY)}
      onPointerUp={handlePointerUp}
      onPointerCancel={() => {
        dragging.current = false;
      }}
      onKeyDown={handleKeyDown}
      sx={(theme) => ({
        position: "relative",
        width: DIAL,
        height: DIAL,
        flexShrink: 0,
        borderRadius: "50%",
        bgcolor: tonal(theme, "text", 0.07),
        touchAction: "none",
        userSelect: "none",
        cursor: "pointer",
        outline: "none",
        "&:focus-visible": {
          boxShadow: `0 0 0 2px ${(theme.vars ?? theme).palette.primary.main}`,
        },
      })}
    >
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          left: CENTER - 1,
          top: CENTER - handleRadius,
          width: 2,
          height: handleRadius,
          bgcolor: "primary.main",
          transformOrigin: "bottom center",
          transform: `rotate(${handleAngle}deg)`,
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          left: CENTER - 4,
          top: CENTER - 4,
          width: 8,
          height: 8,
          borderRadius: "50%",
          bgcolor: "primary.main",
        }}
      />
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          left: handle.x - HANDLE / 2,
          top: handle.y - HANDLE / 2,
          width: HANDLE,
          height: HANDLE,
          borderRadius: "50%",
          bgcolor: "primary.main",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {view === "minutes" && minutes % 5 !== 0 && (
          <Box sx={{ width: 4, height: 4, borderRadius: "50%", bgcolor: "primary.contrastText" }} />
        )}
      </Box>
      {labels.map((l) => (
        <Box
          key={`${l.inner ? "i" : "o"}${l.value}`}
          aria-hidden
          sx={{
            position: "absolute",
            left: l.x - HANDLE / 2,
            top: l.y - HANDLE / 2,
            width: HANDLE,
            height: HANDLE,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: l.inner ? 14 : 16,
            fontVariantNumeric: "tabular-nums",
            pointerEvents: "none",
            color: selectedLabel(l.value)
              ? "primary.contrastText"
              : l.inner
                ? "text.secondary"
                : "text.primary",
          }}
        >
          {l.text}
        </Box>
      ))}
    </Box>
  );
}
