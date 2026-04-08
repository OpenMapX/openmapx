"use client";

import Box from "@mui/material/Box";
import Link from "@mui/material/Link";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useSunTimes } from "@openmapx/core";
import { useTranslations } from "next-intl";

interface Props {
  lat: number;
  lng: number;
  enabled?: boolean;
}

function formatTime(isoString: string, timezone: string): string {
  const date = new Date(isoString);
  return date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  });
}

function formatDayLength(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function PlaceSunTimes({ lat, lng, enabled = true }: Props) {
  const t = useTranslations("sunTimes");
  const { data, isLoading } = useSunTimes(lat, lng, enabled);

  if (isLoading)
    return (
      <Box sx={{ py: 1 }}>
        <Skeleton variant="text" width="70%" />
        <Skeleton variant="text" width="50%" />
      </Box>
    );

  if (!data) return null;

  const tz = data.timezone;
  const fmt = (iso: string) => formatTime(iso, tz);

  return (
    <Box sx={{ py: 1 }}>
      <Box sx={{ display: "flex", gap: 3 }}>
        <Box>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t("sunrise")}</Typography>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{fmt(data.sunrise)}</Typography>
        </Box>
        <Box>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t("sunset")}</Typography>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{fmt(data.sunset)}</Typography>
        </Box>
        <Box>
          <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t("dayLength")}</Typography>
          <Typography sx={{ fontWeight: 600, fontSize: 16 }}>
            {formatDayLength(data.dayLength)}
          </Typography>
        </Box>
      </Box>

      <Box sx={{ display: "flex", gap: 2, mt: 0.75 }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("solarNoon")}: {fmt(data.solarNoon)}
        </Typography>
      </Box>

      <Box sx={{ mt: 0.5 }}>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("civilTwilight")}: {fmt(data.civilTwilightBegin)} – {fmt(data.civilTwilightEnd)}
        </Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("nauticalTwilight")}: {fmt(data.nauticalTwilightBegin)} –{" "}
          {fmt(data.nauticalTwilightEnd)}
        </Typography>
        <Typography sx={{ fontSize: 12, color: "text.secondary" }}>
          {t("astronomicalTwilight")}: {fmt(data.astronomicalTwilightBegin)} –{" "}
          {fmt(data.astronomicalTwilightEnd)}
        </Typography>
      </Box>

      {data.attribution && (
        <Typography variant="caption" color="text.secondary" sx={{ mt: 0.5, display: "block" }}>
          {t("attribution")}{" "}
          <Link
            href={data.attribution.url}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            color="text.secondary"
          >
            {data.attribution.name}
          </Link>
          {data.attribution.licenseUrl ? (
            <>
              {" ("}
              <Link
                href={data.attribution.licenseUrl}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                color="text.secondary"
              >
                {data.attribution.license}
              </Link>
              {")"}
            </>
          ) : data.attribution.license ? (
            ` (${data.attribution.license})`
          ) : null}
        </Typography>
      )}
    </Box>
  );
}
