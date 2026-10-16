"use client";

import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useCurrentWeather, weatherCodeToInfo } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { windDirectionLabel } from "@/components/weather/weatherUtils";
import { AttributionStrip } from "@/integration-api/components/AttributionStrip";
import { WeatherIcon } from "@/integration-api/components/WeatherIcon";
import { useContributorResolver } from "@/integration-api/overlay/useContributorResolver";

interface Props {
  lat: number;
  lng: number;
  enabled?: boolean;
}

export function PlaceWeather({ lat, lng, enabled = true }: Props) {
  const t = useTranslations("weather");
  const { data, isLoading } = useCurrentWeather(lat, lng, enabled);
  const resolve = useContributorResolver();

  if (isLoading)
    return (
      <Box sx={{ py: 1 }}>
        <Skeleton variant="text" width="70%" />
        <Skeleton variant="text" width="50%" />
      </Box>
    );

  if (!data) return null;

  const { current } = data;
  const info = weatherCodeToInfo(current.weatherCode, current.isDay);

  return (
    <Box sx={{ py: 1 }}>
      <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
        <WeatherIcon code={current.weatherCode} isDay={current.isDay} size={28} />
        <Typography sx={{ fontWeight: 600, fontSize: 18 }}>
          {Math.round(current.temperature)}°C
        </Typography>
        <Typography sx={{ color: "text.secondary", fontSize: 14 }}>{info.description}</Typography>
      </Box>
      <Box sx={{ display: "flex", gap: 2, mt: 0.5 }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("feelsLike")} {Math.round(current.feelsLike)}°C
        </Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("windSpeed")}: {Math.round(current.windSpeed)} km/h{" "}
          {windDirectionLabel(current.windDirection)}
        </Typography>
      </Box>
      <Box sx={{ display: "flex", gap: 2 }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("humidity")}: {current.humidity}%
        </Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("pressure")}: {current.pressure} hPa
        </Typography>
      </Box>
      {/* Weather providers can require a source link directly beside their readings. */}
      <AttributionStrip
        keepVisibleWithContent
        variant="plain"
        attributions={resolve({ contributors: data.contributors, sourceIds: [data.source] })}
      />
    </Box>
  );
}
