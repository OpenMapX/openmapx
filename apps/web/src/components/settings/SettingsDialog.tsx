"use client";

import CloseIcon from "@mui/icons-material/Close";
import DialogContent from "@mui/material/DialogContent";
import DialogTitle from "@mui/material/DialogTitle";
import IconButton from "@mui/material/IconButton";
import { useColorScheme } from "@mui/material/styles";
import useMediaQuery from "@mui/material/useMediaQuery";
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
import Dialog from "@/components/ui/Dialog";
import { localeNames, locales } from "@/i18n/config";
import {
  mobileFullScreenDialogPaperSx,
  useFullScreenOnMobile,
} from "@/integration-api/runtime/useFullScreenOnMobile";
import { setLocaleAndReload } from "@/lib/setLocale";
import { NavigationSettingsDialog } from "./NavigationSettingsDialog";
import { ChoiceRow, LinkRow, Section, SwitchRow } from "./settingsPrimitives";
import { VehiclesDialog } from "./VehiclesDialog";

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
  const tv = useTranslations("vehicles");
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
  const searchHistoryEnabled = useSettingsStore((s) => s.searchHistoryEnabled);
  const setSearchHistoryEnabled = useSettingsStore((s) => s.setSearchHistoryEnabled);
  const touchZoomButtons = useSettingsStore((s) => s.touchZoomButtons);
  const setTouchZoomButtons = useSettingsStore((s) => s.setTouchZoomButtons);
  const rememberMapView = useSettingsStore((s) => s.rememberMapView);
  const setRememberMapView = useSettingsStore((s) => s.setRememberMapView);
  const showLocalScript = useSettingsStore((s) => s.showLocalScript);
  const setShowLocalScript = useSettingsStore((s) => s.setShowLocalScript);
  const coarsePointer = useMediaQuery("(pointer: coarse)", { noSsr: true });
  const fullScreen = useFullScreenOnMobile();
  const [navSettingsOpen, setNavSettingsOpen] = useState(false);
  const [vehiclesOpen, setVehiclesOpen] = useState(false);

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
      <DialogContent dividers sx={{ px: 0, pt: 0 }}>
        <Section title={ts("appearance")}>
          <ChoiceRow
            label={t("theme")}
            value={(mode ?? "system") as "light" | "dark" | "system"}
            choices={[
              { value: "system", label: t("themeSystem") },
              { value: "light", label: t("themeLight") },
              { value: "dark", label: t("themeDark") },
            ]}
            onChange={setMode}
          />
          {/* Zoom buttons are always shown with a mouse; only touch screens hide them. */}
          {coarsePointer && (
            <SwitchRow
              label={ts("touchZoomButtons")}
              description={ts("touchZoomButtonsHint")}
              checked={touchZoomButtons}
              onChange={setTouchZoomButtons}
            />
          )}
        </Section>

        <Section title={ts("mapSection")}>
          <SwitchRow
            label={ts("rememberMapView")}
            description={ts("rememberMapViewHint")}
            checked={rememberMapView}
            onChange={setRememberMapView}
          />
          <SwitchRow
            label={ts("showLocalScript")}
            description={ts("showLocalScriptHint")}
            checked={showLocalScript}
            onChange={setShowLocalScript}
          />
        </Section>

        <Section title={ts("languageAndRegion")}>
          <ChoiceRow
            label={t("language")}
            value={locale}
            choices={locales.map((l) => ({ value: l, label: localeNames[l] ?? l }))}
            onChange={(next) => {
              if (next !== locale) void setLocaleAndReload(next);
            }}
          />
          <ChoiceRow
            label={t("units")}
            value={units}
            choices={[
              { value: "metric", label: t("unitsMetric") },
              { value: "imperial", label: t("unitsImperial") },
            ]}
            onChange={(next) => setUnits(next as UnitSystem)}
          />
          <ChoiceRow
            label={t("timeFormat")}
            value={timeFormat}
            choices={TIME_FORMAT_OPTIONS.map((o) => ({
              value: o.value,
              label: `${t(o.labelKey)} · ${formatClockTime(SAMPLE_DATETIME, {
                locale,
                timeFormat: o.value,
              })}`,
            }))}
            onChange={(next) => setTimeFormat(next as TimeFormat)}
          />
          <ChoiceRow
            label={t("dateFormat")}
            value={dateFormat}
            choices={DATE_FORMAT_OPTIONS.map((o) => ({
              value: o.value,
              label: `${t(o.labelKey)} · ${formatCalendarDate(SAMPLE_DATETIME, {
                locale,
                dateFormat: o.value,
              })}`,
            }))}
            onChange={(next) => setDateFormat(next as DateFormat)}
          />
        </Section>

        <Section title={ts("navigation")}>
          <LinkRow label={tn("title")} onClick={() => setNavSettingsOpen(true)} />
          <LinkRow label={tv("title")} onClick={() => setVehiclesOpen(true)} />
        </Section>

        <Section title={ts("search")}>
          <SwitchRow
            label={ts("aiSearch")}
            description={ts("aiSearchHint")}
            checked={aiSearchEnabled}
            onChange={setAiSearchEnabled}
          />
          <SwitchRow
            label={ts("searchHistory")}
            description={ts("searchHistoryHint")}
            checked={searchHistoryEnabled}
            onChange={setSearchHistoryEnabled}
          />
        </Section>
      </DialogContent>
      <NavigationSettingsDialog open={navSettingsOpen} onClose={() => setNavSettingsOpen(false)} />
      <VehiclesDialog open={vehiclesOpen} onClose={() => setVehiclesOpen(false)} />
    </Dialog>
  );
}
