"use client";

import Box from "@mui/material/Box";
import Skeleton from "@mui/material/Skeleton";
import Typography from "@mui/material/Typography";
import { useSunTimes } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { SectionAttribution } from "@/components/ui/SectionAttribution";
import { useDateTimeFormat } from "@/lib/useDateTimeFormat";

interface Props {
  lat: number;
  lng: number;
  enabled?: boolean;
}

function formatDayLength(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

export function PlaceSunTimes({ lat, lng, enabled = true }: Props) {
  const t = useTranslations("sunTimes");
  const dtf = useDateTimeFormat();
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
  const fmt = (iso: string) => dtf.time(iso, { timeZone: tz });

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
        <SectionAttribution
          name={data.attribution.name}
          url={data.attribution.url}
          license={data.attribution.license}
          licenseUrl={data.attribution.licenseUrl}
        />
      )}
    </Box>
  );
}
