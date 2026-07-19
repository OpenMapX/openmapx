"use client";

import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import Dialog from "@mui/material/Dialog";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import ListItemButton from "@mui/material/ListItemButton";
import ListItemText from "@mui/material/ListItemText";
import MenuItem from "@mui/material/MenuItem";
import Select from "@mui/material/Select";
import Switch from "@mui/material/Switch";
import { useColorScheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import {
  type DateFormat,
  formatCalendarDate,
  formatClockTime,
  type TimeFormat,
  type UnitSystem,
  useSettingsStore,
} from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useState } from "react";
import { localeNames, locales } from "@/i18n/config";
import { setLocaleAndReload } from "@/lib/setLocale";
import { mobileFullScreenDialogPaperSx, useFullScreenOnMobile } from "@/lib/useFullScreenOnMobile";
import { NavigationSettingsDialog } from "./NavigationSettingsDialog";
import { Section, SettingRow } from "./settingsPrimitives";

// Fixed sample instant (Dec 31, 2025, 13:05 local) used to preview each
// date/time format option in the dropdowns.
const SAMPLE_DATETIME = new Date(2025, 11, 31, 13, 5);

const TIME_FORMAT_OPTIONS: { value: TimeFormat; labelKey: string }[] = [
  { value: "auto", labelKey: "timeFormatAuto" },
  { value: "12h", labelKey: "timeFormat12h" },
  { value: "24h", labelKey: "timeFormat24h" },
];

const DATE_FORMAT_OPTIONS: { value: DateFormat; labelKey: string }[] = [
  { value: "auto", labelKey: "dateFormatAuto" },
  { value: "dmy", labelKey: "dateFormatDmy" },
  { value: "mdy", labelKey: "dateFormatMdy" },
  { value: "ymd", labelKey: "dateFormatYmd" },
];

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useTranslations("menu");
  const ts = useTranslations("settings");
  const tn = useTranslations("navigationSettings");
  const tc = useTranslations("common");
  const locale = useLocale();
  const { mode, setMode } = useColorScheme();
  const units = useSettingsStore((s) => s.units);
  const setUnits = useSettingsStore((s) => s.setUnits);
  const timeFormat = useSettingsStore((s) => s.timeFormat);
  const setTimeFormat = useSettingsStore((s) => s.setTimeFormat);
  const dateFormat = useSettingsStore((s) => s.dateFormat);
  const setDateFormat = useSettingsStore((s) => s.setDateFormat);
  const aiSearchEnabled = useSettingsStore((s) => s.aiSearchEnabled);
  const setAiSearchEnabled = useSettingsStore((s) => s.setAiSearchEnabled);
  const fullScreen = useFullScreenOnMobile();
  const [navSettingsOpen, setNavSettingsOpen] = useState(false);

  return (
    <Dialog
      open={open}
      onClose={onClose}
      maxWidth="xs"
      fullWidth
      fullScreen={fullScreen}
      slotProps={{ paper: { sx: mobileFullScreenDialogPaperSx } }}
    >
      <DialogTitle sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        {ts("title")}
        <IconButton onClick={onClose} aria-label={tc("close")} edge="end">
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent dividers>
        <Section title={ts("appearance")}>
          <SettingRow label={t("theme")}>
            <Select
              size="small"
              fullWidth
              value={mode ?? "system"}
              onChange={(e) => setMode(e.target.value as "light" | "dark" | "system")}
            >
              <MenuItem value="system">{t("themeSystem")}</MenuItem>
              <MenuItem value="light">{t("themeLight")}</MenuItem>
              <MenuItem value="dark">{t("themeDark")}</MenuItem>
            </Select>
          </SettingRow>
        </Section>

        <Section title={ts("languageAndRegion")}>
          <SettingRow label={t("language")}>
            <Select
              size="small"
              fullWidth
              value={locale}
              onChange={(e) => {
                if (e.target.value !== locale) setLocaleAndReload(e.target.value);
              }}
            >
              {locales.map((l) => (
                <MenuItem key={l} value={l}>
                  {localeNames[l] ?? l}
                </MenuItem>
              ))}
            </Select>
          </SettingRow>

          <SettingRow label={t("units")}>
            <Select
              size="small"
              fullWidth
              value={units}
              onChange={(e) => setUnits(e.target.value as UnitSystem)}
            >
              <MenuItem value="metric">{t("unitsMetric")}</MenuItem>
              <MenuItem value="imperial">{t("unitsImperial")}</MenuItem>
            </Select>
          </SettingRow>

          <SettingRow label={t("timeFormat")}>
            <Select
              size="small"
              fullWidth
              value={timeFormat}
              onChange={(e) => setTimeFormat(e.target.value as TimeFormat)}
            >
              {TIME_FORMAT_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {`${t(o.labelKey)} · ${formatClockTime(SAMPLE_DATETIME, {
                    locale,
                    timeFormat: o.value,
                  })}`}
                </MenuItem>
              ))}
            </Select>
          </SettingRow>

          <SettingRow label={t("dateFormat")}>
            <Select
              size="small"
              fullWidth
              value={dateFormat}
              onChange={(e) => setDateFormat(e.target.value as DateFormat)}
            >
              {DATE_FORMAT_OPTIONS.map((o) => (
                <MenuItem key={o.value} value={o.value}>
                  {`${t(o.labelKey)} · ${formatCalendarDate(SAMPLE_DATETIME, {
                    locale,
                    dateFormat: o.value,
                  })}`}
                </MenuItem>
              ))}
            </Select>
          </SettingRow>
        </Section>

        <Section title={ts("navigation")}>
          <ListItemButton onClick={() => setNavSettingsOpen(true)} sx={{ borderRadius: 1, px: 1 }}>
            <ListItemText primary={tn("title")} />
            <ChevronRightIcon sx={{ color: "text.secondary" }} />
          </ListItemButton>
        </Section>

        <Section title={ts("search")}>
          <SettingRow label={ts("aiSearch")}>
            <Switch
              checked={aiSearchEnabled}
              onChange={(e) => setAiSearchEnabled(e.target.checked)}
            />
          </SettingRow>
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {ts("aiSearchHint")}
          </Typography>
        </Section>
      </DialogContent>
      <NavigationSettingsDialog open={navSettingsOpen} onClose={() => setNavSettingsOpen(false)} />
    </Dialog>
  );
}
