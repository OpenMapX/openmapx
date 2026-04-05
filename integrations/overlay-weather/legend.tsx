"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import IconButton from "@mui/material/IconButton";
import LinearProgress from "@mui/material/LinearProgress";
import Paper from "@mui/material/Paper";
import Slider from "@mui/material/Slider";
import Switch from "@mui/material/Switch";
import { useTheme } from "@mui/material/styles";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { type WeatherSubLayer, weatherCodeToInfo } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { WeatherIcon } from "@/components/weather/WeatherIcon";
import { useWeatherStore } from "./store";

const SUB_LAYERS: { key: WeatherSubLayer; needsOwm: boolean }[] = [
  { key: "radar", needsOwm: false },
  { key: "temperature", needsOwm: true },
  { key: "clouds", needsOwm: true },
  { key: "wind", needsOwm: true },
  { key: "pressure", needsOwm: true },
  { key: "precipitation", needsOwm: true },
];

function formatFrameTime(unix: number, pastCount: number, index: number): string {
  if (index === pastCount - 1) return "Now";
  const diffMin = Math.round((unix - Date.now() / 1000) / 60);
  if (diffMin === 0) return "Now";
  const abs = Math.abs(diffMin);
  const sign = diffMin < 0 ? "-" : "+";
  if (abs >= 60) return `${sign}${Math.round(abs / 60)}h`;
  return `${sign}${abs}m`;
}

export function WeatherLegend() {
  const t = useTranslations("weather");
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const panelOpen = useWeatherStore((s) => s.panelOpen);
  const layerVisible = useWeatherStore((s) => s.layerVisible);
  const setLayerVisible = useWeatherStore((s) => s.setLayerVisible);
  const loading = useWeatherStore((s) => s.loading);
  const radarLoading = useWeatherStore((s) => s.radarLoading);

  const activeSubLayer = useWeatherStore((s) => s.activeSubLayer);
  const setActiveSubLayer = useWeatherStore((s) => s.setActiveSubLayer);
  const owmAvailable = useWeatherStore((s) => s.owmAvailable);

  const radarPlaying = useWeatherStore((s) => s.radarPlaying);
  const setRadarPlaying = useWeatherStore((s) => s.setRadarPlaying);
  const radarFrameIndex = useWeatherStore((s) => s.radarFrameIndex);
  const setRadarFrameIndex = useWeatherStore((s) => s.setRadarFrameIndex);
  const radarPastFrames = useWeatherStore((s) => s.radarPastFrames);
  const radarNowcastFrames = useWeatherStore((s) => s.radarNowcastFrames);
  const currentWeather = useWeatherStore((s) => s.currentWeather);
  const locationName = useWeatherStore((s) => s.locationName);
  const radarUnavailable = useWeatherStore((s) => s.radarUnavailable);

  if (!panelOpen) return null;

  const allFrames = [...radarPastFrames, ...radarNowcastFrames];
  const availableSubLayers = SUB_LAYERS.filter(({ needsOwm }) => !needsOwm || owmAvailable);
  const showRadarControls = activeSubLayer === "radar" && allFrames.length > 0 && !radarUnavailable;

  return (
    <Paper
      elevation={3}
      sx={{
        position: "relative",
        px: 2,
        py: 1.5,
        borderRadius: "12px",
        overflow: "hidden",
        maxWidth: { xs: "90vw", sm: 440 },
        minWidth: 280,
      }}
    >
      {(loading || radarLoading) && (
        <LinearProgress
          sx={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 2,
            borderRadius: "12px 12px 0 0",
          }}
        />
      )}

      {/* Header: title with location + toggle */}
      <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 1 }}>
        <Typography
          sx={{
            fontWeight: 600,
            fontSize: 14,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 300,
          }}
        >
          {locationName ? t("weatherAt", { location: locationName }) : t("weather")}
        </Typography>
        <Switch
          size="small"
          checked={layerVisible}
          onChange={(e) => setLayerVisible(e.target.checked)}
          inputProps={{ "aria-label": t("toggleOverlay") }}
          sx={{ ml: 2 }}
        />
      </Box>

      {/* Current weather conditions */}
      {currentWeather ? (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1, mb: 1.5 }}>
          <WeatherIcon code={currentWeather.weatherCode} isDay={currentWeather.isDay} size={28} />
          <Box sx={{ minWidth: 0 }}>
            <Box sx={{ display: "flex", alignItems: "baseline", gap: 0.75 }}>
              <Typography sx={{ fontWeight: 600, fontSize: 18, lineHeight: 1 }}>
                {Math.round(currentWeather.temperature)}°C
              </Typography>
              <Typography sx={{ fontSize: 13, color: "text.secondary" }}>
                {weatherCodeToInfo(currentWeather.weatherCode, currentWeather.isDay).description}
              </Typography>
            </Box>
            {/* Detail lines — hidden on mobile for compact mode */}
            <Box sx={{ display: { xs: "none", sm: "block" } }}>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.25 }}>
                {t("feelsLike")} {Math.round(currentWeather.feelsLike)}°C
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                {t("windSpeed")}: {Math.round(currentWeather.windSpeed)} km/h · {t("humidity")}:{" "}
                {currentWeather.humidity}%
              </Typography>
              <Typography sx={{ fontSize: 11.5, color: "text.secondary" }}>
                {t("pressure")}: {currentWeather.pressure} hPa · {t("cloudCover")}:{" "}
                {currentWeather.cloudCover}%
              </Typography>
            </Box>
          </Box>
        </Box>
      ) : !loading ? (
        <Typography sx={{ fontSize: 12, color: "text.secondary", mb: 1.5 }}>
          {t("noData")}
        </Typography>
      ) : null}

      {/* Sub-layer chips — hidden when only one option available */}
      {availableSubLayers.length > 1 && (
        <Box
          sx={{
            display: "flex",
            gap: 0.75,
            flexWrap: { xs: "nowrap", sm: "wrap" },
            overflowX: { xs: "auto", sm: "visible" },
            mb: 1.5,
            pb: 0.5,
            "&::-webkit-scrollbar": { height: 0 },
          }}
        >
          {availableSubLayers.map(({ key }) => (
            <Chip
              key={key}
              label={t(key)}
              size="small"
              variant={activeSubLayer === key ? "filled" : "outlined"}
              color={activeSubLayer === key ? "primary" : "default"}
              onClick={() => setActiveSubLayer(key)}
              sx={{ fontSize: 12 }}
            />
          ))}
        </Box>
      )}

      {/* Radar time slider + play button */}
      {showRadarControls && (
        <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
          {/* Play button — hidden on mobile to save battery */}
          {!isMobile && (
            <IconButton
              size="small"
              onClick={() => setRadarPlaying(!radarPlaying)}
              aria-label={radarPlaying ? t("radarPause") : t("radarPlay")}
              sx={{ minWidth: 44, minHeight: 44 }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="currentColor"
                aria-hidden="true"
              >
                {radarPlaying ? (
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                ) : (
                  <path d="M8 5v14l11-7z" />
                )}
              </svg>
            </IconButton>
          )}
          <Slider
            size="small"
            min={0}
            max={allFrames.length - 1}
            value={radarFrameIndex}
            onChange={(_, v) => {
              setRadarPlaying(false);
              setRadarFrameIndex(v as number);
            }}
            valueLabelDisplay="auto"
            valueLabelFormat={(v) =>
              formatFrameTime(allFrames[v]?.time ?? 0, radarPastFrames.length, v)
            }
            sx={{ flex: 1 }}
          />
          <Typography
            sx={{ fontSize: 11, color: "text.secondary", minWidth: 36, textAlign: "right" }}
          >
            {allFrames[radarFrameIndex]
              ? formatFrameTime(
                  allFrames[radarFrameIndex].time,
                  radarPastFrames.length,
                  radarFrameIndex,
                )
              : ""}
          </Typography>
        </Box>
      )}

      {/* Radar unavailable message */}
      {activeSubLayer === "radar" && radarUnavailable && (
        <Typography sx={{ fontSize: 12, color: "error.main", mb: 0.75 }}>
          {t("radarUnavailable")}
        </Typography>
      )}

      {/* Attribution */}
      <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.75 }}>
        {t("attribution")}{" "}
        <a
          href="https://open-meteo.com/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          Open-Meteo
        </a>{" "}
        (CC BY 4.0) · {t("radarBy")}{" "}
        <a
          href="https://www.rainviewer.com/"
          target="_blank"
          rel="noreferrer"
          style={{ color: "inherit" }}
        >
          RainViewer
        </a>
        {owmAvailable && (
          <>
            {" "}
            · {t("tilesBy")}{" "}
            <a
              href="https://openweathermap.org/"
              target="_blank"
              rel="noreferrer"
              style={{ color: "inherit" }}
            >
              OpenWeatherMap
            </a>
          </>
        )}
      </Typography>
    </Paper>
  );
}
