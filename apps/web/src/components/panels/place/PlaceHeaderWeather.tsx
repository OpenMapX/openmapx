"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { timeZoneAt, useCurrentWeather, weatherCodeToInfo } from "@openmapx/core";
import { useEffect, useMemo, useState } from "react";
import { AttributionStrip } from "@/integration-api/components/AttributionStrip";
import { WeatherIcon } from "@/integration-api/components/WeatherIcon";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";

interface Props {
  lat: number;
  lng: number;
}

/**
 * Compact weather + local-time readout shown in the header of a city place
 * panel (sun icon, "Clear · 14°C", local time). Renders
 * nothing until weather data is available, so it never reserves empty space.
 */
export function PlaceHeaderWeather({ lat, lng }: Props) {
  const fmt = useDateTimeFormat();
  const { data } = useCurrentWeather(lat, lng);
  const resolve = useContributorResolver();
  const [now, setNow] = useState(() => new Date());

  // Re-render every minute so the displayed local time stays current.
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(id);
  }, []);

  // tz-lookup is a point-in-polygon search; memoize so it isn't recomputed on
  // every render (notably the once-a-minute clock tick).
  const timeZone = useMemo(() => timeZoneAt(lat, lng), [lat, lng]);

  if (!data) return null;

  const { current } = data;
  const info = weatherCodeToInfo(current.weatherCode, current.isDay);
  const localTime = fmt.time(now, { timeZone: timeZone ?? undefined });

  return (
    <Box
      sx={{
        display: "flex",
        flexDirection: "column",
        alignItems: "flex-end",
        flexShrink: 0,
        textAlign: "right",
        ml: 1,
      }}
    >
      <WeatherIcon code={current.weatherCode} isDay={current.isDay} size={40} />
      <Typography variant="body2" sx={{ color: "text.secondary", mt: 0.25, whiteSpace: "nowrap" }}>
        {info.description} · {Math.round(current.temperature)}°C
      </Typography>
      <Typography variant="body2" sx={{ color: "text.secondary", whiteSpace: "nowrap" }}>
        {localTime}
      </Typography>
      {/* Weather providers can require a source link directly beside their readings. */}
      <AttributionStrip
        keepVisibleWithContent
        variant="plain"
        attributions={resolve({ contributors: data.contributors, sourceIds: [data.source] })}
      />
    </Box>
  );
}
