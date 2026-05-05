"use client";

import Box from "@mui/material/Box";
import Paper from "@mui/material/Paper";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  buildSourceAttribution,
  useCurrentWeather,
  useDebouncedCallback,
  useIntegrationRegistry,
  weatherCodeToInfo,
} from "@openmapx/core";
import { useCallback, useEffect, useState } from "react";
import { useMap } from "@/lib/MapContext";
import { WeatherIcon } from "./WeatherIcon";
import { windDirectionLabel } from "./weatherUtils";

export function WeatherWidget() {
  const theme = useTheme();
  const isMobile = useMediaQuery(theme.breakpoints.down("sm"));
  const { mapRef, mapReady } = useMap();
  const [center, setCenter] = useState<{ lat: number; lng: number } | null>(null);
  const [zoom, setZoom] = useState(0);

  const updateCenter = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;
    const c = map.getCenter();
    setCenter({ lat: Math.round(c.lat * 10) / 10, lng: Math.round(c.lng * 10) / 10 });
    setZoom(map.getZoom());
  }, [mapRef]);

  const debouncedUpdate = useDebouncedCallback(updateCenter, 2000);

  useEffect(() => {
    if (isMobile) return;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    updateCenter();
    map.on("moveend", debouncedUpdate);
    return () => {
      map.off("moveend", debouncedUpdate);
    };
  }, [isMobile, mapRef, mapReady, updateCenter, debouncedUpdate]);

  // Pass nulls on mobile so the underlying query is disabled — no fetch.
  const { data } = useCurrentWeather(
    !isMobile && center && zoom >= 8 ? center.lat : null,
    !isMobile && center && zoom >= 8 ? center.lng : null,
  );

  const registry = useIntegrationRegistry();

  if (isMobile || !data || zoom < 8) return null;

  const { current } = data;
  const info = weatherCodeToInfo(current.weatherCode, current.isDay);
  const weatherMeta = data.source
    ? registry
        .getByDomain("weather")
        .find((m) => m.dataSources?.some((ds) => ds.sourceId === data.source))
    : undefined;
  const attrText = weatherMeta?.dataSources
    ? buildSourceAttribution(weatherMeta.dataSources, [data.source]).replace(/<[^>]*>/g, "")
    : data.source;

  return (
    <Box
      sx={{
        position: "absolute",
        top: { xs: 118, sm: 74 },
        left: 12,
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
            H:{current.humidity}% W:{Math.round(current.windSpeed)}km/h{" "}
            {windDirectionLabel(current.windDirection)}
          </Typography>
        </Paper>
      </Tooltip>
    </Box>
  );
}
