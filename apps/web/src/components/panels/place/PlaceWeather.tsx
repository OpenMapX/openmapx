"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import { useCurrentWeather, weatherCodeToInfo } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { WeatherIcon } from "@/components/weather/WeatherIcon";
import { windDirectionLabel } from "@/components/weather/weatherUtils";

interface Props {
  lat: number;
  lng: number;
}

export function PlaceWeather({ lat, lng }: Props) {
  const t = useTranslations("weather");
  const { data, isLoading } = useCurrentWeather(lat, lng);

  if (isLoading || !data) return null;

  const { current, attribution } = data;
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
      {attribution && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {t("attribution")}{" "}
          <Link
            href={attribution.url}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            color="text.secondary"
          >
            {attribution.name}
          </Link>
          {attribution.licenseUrl ? (
            <>
              {" ("}
              <Link
                href={attribution.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                color="text.secondary"
              >
                {attribution.license}
              </Link>
              {")"}
            </>
          ) : (
            ` (${attribution.license})`
          )}
        </Typography>
      )}
    </Box>
  );
}
