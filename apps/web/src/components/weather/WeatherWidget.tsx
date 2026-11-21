"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { parseAttributionHtml, weatherCodeToInfo } from "@openmapx/core";
import { CHIP_ROW_END } from "@/components/search/floatingChipSx";
import { WeatherIcon } from "@/integration-api/components/WeatherIcon";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";
import { useMapAttributions } from "@/integration-api/overlay/useMapAttributions";
import { SEARCH_BAR_INSET, topInset } from "@/lib/layout";
import { useMapCenterWeather } from "./useMapCenterWeather";
import { windDirectionLabel } from "./weatherUtils";

export function WeatherWidget() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  // Disabled on mobile, so nothing is fetched there.
  const { data, zoom } = useMapCenterWeather({ enabled: !isMobile });

  const resolve = useContributorResolver();
  const widgetVisible = !isMobile && !!data && zoom >= 8;
  const weatherAttributions =
    widgetVisible && data
      ? resolve({ contributors: data.contributors, sourceIds: [data.source] })
      : [];
  const attrText = weatherAttributions
    .map((attr) => parseAttributionHtml(attr.attributionText ?? attr.name).text)
    .join(" · ");
  useMapAttributions("weather", weatherAttributions);

  if (isMobile || !data || zoom < 8) return null;

  const { current } = data;
  const info = weatherCodeToInfo(current.weatherCode, current.isDay);
  const readings: string[] = [];
  if (current.humidity != null) readings.push(`H:${current.humidity}%`);
  if (current.windSpeed != null) {
    readings.push(`W:${Math.round(current.windSpeed)}km/h`);
    if (current.windDirection != null) readings.push(windDirectionLabel(current.windDirection));
  }

  return (
    <Box
      sx={{
        position: "absolute",
        top: {
          xs: topInset(SEARCH_BAR_INSET, CHIP_ROW_END.xs + 8),
          sm: topInset(SEARCH_BAR_INSET, 62),
        },
        left: "calc(12px + var(--omx-safe-left))",
        zIndex: 9,
        width: { xs: "calc(100% - 110px)", sm: "auto" },
      }}
    >
      <Tooltip title={attrText} placement="bottom-start">
        <Paper
          elevation={1}
          sx={{
            display: "flex",
            alignItems: "center",
            gap: 0.75,
            width: { xs: "100%", sm: 376 },
            px: 1.5,
            py: 0.75,
            borderRadius: "20px",
            bgcolor: "background.paper",
            cursor: "default",
            userSelect: "none",
            transition: "opacity 0.3s",
          }}
        >
          <WeatherIcon code={current.weatherCode} isDay={current.isDay} size={20} />
          <Typography sx={{ fontWeight: 600, fontSize: 14, lineHeight: 1 }}>
            {Math.round(current.temperature)}°C
          </Typography>
          <Typography
            sx={{
              fontSize: 13,
              color: "text.secondary",
              lineHeight: 1,
              display: { xs: "none", sm: "inline" },
              flex: 1,
              minWidth: 0,
            }}
          >
            {info.description}
          </Typography>
          <Typography
            sx={{
              fontSize: 12,
              color: "text.secondary",
              lineHeight: 1,
              display: { xs: "none", sm: "inline" },
              ml: "auto",
              textAlign: "right",
              whiteSpace: "nowrap",
            }}
          >
            {readings.join(" ")}
          </Typography>
        </Paper>
      </Tooltip>
    </Box>
  );
}
