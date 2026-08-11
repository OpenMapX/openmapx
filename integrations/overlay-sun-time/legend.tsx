"use client";

import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import TextField from "@mui/material/TextField";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { useSunTimeStore } from "./store";

const BAND_STOPS = [
  { key: "day", color: "rgba(11, 16, 38, 0)" },
  { key: "civil", color: "rgba(11, 16, 38, 0.18)" },
  { key: "nautical", color: "rgba(11, 16, 38, 0.36)" },
  { key: "night", color: "rgba(11, 16, 38, 0.55)" },
] as const;

function toDateInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export default function SunTimeLegend() {
  const t = useTranslations("sunTime");
  const panelOpen = useSunTimeStore((s) => s.panelOpen);
  const layerVisible = useSunTimeStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("sun-time");
  const showTerminator = useSunTimeStore((s) => s.showTerminator);
  const setShowTerminator = useSunTimeStore((s) => s.setShowTerminator);
  const showTimeZones = useSunTimeStore((s) => s.showTimeZones);
  const setShowTimeZones = useSunTimeStore((s) => s.setShowTimeZones);
  const tzLoading = useSunTimeStore((s) => s.tzLoading);
  const timeMs = useSunTimeStore((s) => s.timeMs);
  const setTimeMs = useSunTimeStore((s) => s.setTimeMs);
  const resetToNow = useSunTimeStore((s) => s.resetToNow);

  // Controls always reflect a concrete instant; a null store value simply means
  // "whatever the clock says right now", which is the instant the layer draws.
  const shown = new Date(timeMs ?? Date.now());
  const minutesOfDay = shown.getHours() * 60 + shown.getMinutes();

  const setMinutes = (minutes: number) => {
    const next = new Date(shown);
    next.setHours(Math.floor(minutes / 60), minutes % 60, 0, 0);
    setTimeMs(next.getTime());
  };

  const setDate = (value: string) => {
    const [year, month, day] = value.split("-").map(Number);
    if (!year || !month || !day) return;
    const next = new Date(shown);
    next.setFullYear(year, month - 1, day);
    setTimeMs(next.getTime());
  };

  return (
    <OverlayLegend
      title={t("sunTime")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={tzLoading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 360 }, minWidth: 260 }}
      headerSx={{ mb: 1 }}
    >
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography sx={{ fontSize: 13 }}>{t("dayNight")}</Typography>
        <Switch
          size="small"
          checked={showTerminator}
          onChange={(e) => setShowTerminator(e.target.checked)}
          slotProps={{ input: { "aria-label": t("dayNight") } }}
        />
      </Box>

      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography sx={{ fontSize: 13 }}>{t("timeZones")}</Typography>
        <Switch
          size="small"
          checked={showTimeZones}
          onChange={(e) => setShowTimeZones(e.target.checked)}
          slotProps={{ input: { "aria-label": t("timeZones") } }}
        />
      </Box>

      <Box sx={{ display: "flex", gap: 0.25, mt: 1.5, mb: 0.5 }}>
        {BAND_STOPS.map((stop) => (
          <Box key={stop.key} sx={{ flex: 1 }}>
            <Box
              sx={{
                height: 8,
                borderRadius: 0.5,
                bgcolor: stop.color,
                border: "1px solid",
                borderColor: "divider",
              }}
            />
            <Typography sx={{ fontSize: 10, color: "text.secondary", mt: 0.25 }}>
              {t(stop.key)}
            </Typography>
          </Box>
        ))}
      </Box>

      <Box sx={{ display: "flex", gap: 1, alignItems: "center", mt: 1.5 }}>
        <TextField
          size="small"
          type="date"
          label={t("date")}
          value={toDateInput(shown)}
          onChange={(e) => setDate(e.target.value)}
          slotProps={{ inputLabel: { shrink: true } }}
          sx={{ flex: 1 }}
        />
        <Button size="small" onClick={resetToNow} disabled={timeMs === null}>
          {t("now")}
        </Button>
      </Box>

      <Box sx={{ mt: 1 }}>
        <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
          {t("time")}: {String(shown.getHours()).padStart(2, "0")}:
          {String(shown.getMinutes()).padStart(2, "0")}
        </Typography>
        <Slider
          size="small"
          min={0}
          max={1430}
          step={10}
          value={minutesOfDay}
          onChange={(_, value) => setMinutes(value as number)}
          aria-label={t("time")}
        />
      </Box>
    </OverlayLegend>
  );
}
