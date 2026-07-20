"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { DouglasSeaState, MarineHourlyPoint, MarineWeatherResponse } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { SectionAttribution } from "@/components/ui/SectionAttribution";
import { useDataSourceAttribution } from "./useDataSourceAttribution";

/**
 * Sea-conditions widget for coastal place panels. Mounted by
 * `PlaceOverviewTab` when `useMarineWeather` returns a non-null payload —
 * Open-Meteo's marine grid covers the open ocean and most coastal cells,
 * but returns 204 for inland queries, so this component only renders when
 * the upstream actually had data for the point.
 */
export function PlaceMarineWeatherContent({ data }: { data: MarineWeatherResponse }) {
  const t = useTranslations("marineWeather");
  const attributionSource = useDataSourceAttribution(
    "knowledge-marine-weather",
    "open-meteo-marine",
  );

  const { current, hourly } = data;

  return (
    <Box sx={{ py: 1 }}>
      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "flex-start" }}>
        {current.waveHeightM !== undefined && (
          <ConditionBlock
            label={t("wave")}
            heightM={current.waveHeightM}
            directionDeg={current.waveDirectionDeg}
            periodS={current.wavePeriodS}
            t={t}
          />
        )}
        {current.swellHeightM !== undefined && (
          <ConditionBlock
            label={t("swell")}
            heightM={current.swellHeightM}
            directionDeg={current.swellDirectionDeg}
            periodS={current.swellPeriodS}
            t={t}
          />
        )}
        {current.currentVelocityMs !== undefined && (
          <CurrentBlock
            velocityMs={current.currentVelocityMs}
            directionDeg={current.currentDirectionDeg}
            t={t}
          />
        )}
      </Box>

      <Box sx={{ mt: 1 }}>
        <SeaStateBadge state={current.seaState} t={t} />
      </Box>

      {hourly.length > 1 && (
        <Box sx={{ mt: 1.5 }}>
          <WaveSparkline hourly={hourly} now={Date.now()} />
        </Box>
      )}

      {attributionSource && (
        <SectionAttribution
          name={attributionSource.name}
          url={attributionSource.url}
          license={attributionSource.license}
          licenseUrl={attributionSource.licenseUrl}
          attribution={attributionSource.attribution}
        />
      )}
    </Box>
  );
}

function ConditionBlock({
  label,
  heightM,
  directionDeg,
  periodS,
  t,
}: {
  label: string;
  heightM: number;
  directionDeg?: number;
  periodS?: number;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        sx={{
          fontSize: 10.5,
          color: "text.secondary",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {label}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.2 }}>
        {directionDeg !== undefined && (
          <Arrow
            direction={directionDeg}
            // For waves and swell the meteorological convention is "direction
            // FROM" — flip 180° so the arrow points the way the wave travels.
            flip
          />
        )}
        <Typography sx={{ fontWeight: 600, fontSize: 16, lineHeight: 1 }}>
          {t("heightM", { m: heightM })}
        </Typography>
      </Box>
      {periodS !== undefined && (
        <Typography sx={{ fontSize: 11, color: "text.secondary", mt: 0.2 }}>
          {t("period", { seconds: Math.round(periodS) })}
        </Typography>
      )}
    </Box>
  );
}

function CurrentBlock({
  velocityMs,
  directionDeg,
  t,
}: {
  velocityMs: number;
  directionDeg?: number;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Box sx={{ minWidth: 0 }}>
      <Typography
        sx={{
          fontSize: 10.5,
          color: "text.secondary",
          letterSpacing: 0.4,
          textTransform: "uppercase",
        }}
      >
        {t("current")}
      </Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, mt: 0.2 }}>
        {directionDeg !== undefined && <Arrow direction={directionDeg} />}
        <Typography sx={{ fontWeight: 600, fontSize: 16, lineHeight: 1 }}>
          {t("velocityMs", { ms: velocityMs })}
        </Typography>
      </Box>
    </Box>
  );
}

const SEA_STATE_COLOR: Record<DouglasSeaState, string> = {
  "calm-glassy": "#0ea5e9",
  "calm-rippled": "#22c55e",
  smooth: "#22c55e",
  slight: "#84cc16",
  moderate: "#eab308",
  rough: "#f97316",
  "very-rough": "#ef4444",
  high: "#dc2626",
  "very-high": "#b91c1c",
  phenomenal: "#7f1d1d",
};

function SeaStateBadge({
  state,
  t,
}: {
  state: DouglasSeaState;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Box
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.6,
        py: 0.3,
        px: 0.9,
        borderRadius: 1,
        bgcolor: `${SEA_STATE_COLOR[state]}22`,
        border: 1,
        borderColor: `${SEA_STATE_COLOR[state]}66`,
      }}
    >
      <Box sx={{ width: 8, height: 8, borderRadius: "50%", bgcolor: SEA_STATE_COLOR[state] }} />
      <Typography sx={{ fontSize: 11, fontWeight: 600, color: "text.primary" }}>
        {t(`seaState-${state}`)}
      </Typography>
    </Box>
  );
}

function Arrow({ direction, flip = false }: { direction: number; flip?: boolean }) {
  const rotation = flip ? direction + 180 : direction;
  return (
    <Box
      sx={{
        display: "inline-flex",
        transform: `rotate(${rotation}deg)`,
        color: "text.secondary",
      }}
    >
      <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <title>direction</title>
        <path d="M12 2 L18 12 L13.5 12 L13.5 22 L10.5 22 L10.5 12 L6 12 Z" fill="currentColor" />
      </svg>
    </Box>
  );
}

function WaveSparkline({ hourly, now }: { hourly: MarineHourlyPoint[]; now: number }) {
  const points = hourly
    .map((p) => ({ t: new Date(p.time).getTime(), v: p.waveHeightM }))
    .filter((p): p is { t: number; v: number } => p.v !== undefined && Number.isFinite(p.v));
  if (points.length < 2) return null;

  const W = 240;
  const H = 32;
  const PAD_Y = 2;
  const minT = points[0].t;
  const maxT = points[points.length - 1].t;
  const minV = Math.min(...points.map((p) => p.v));
  const maxV = Math.max(...points.map((p) => p.v));
  const xRange = maxT - minT || 1;
  const yRange = Math.max(maxV - minV, 0.1);

  const path = points
    .map((p, i) => {
      const x = ((p.t - minT) / xRange) * W;
      const y = H - PAD_Y - ((p.v - minV) / yRange) * (H - PAD_Y * 2);
      return `${i === 0 ? "M" : "L"} ${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

  const nowX = Math.max(0, Math.min(W, ((now - minT) / xRange) * W));

  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`}>
      <title>Wave height — next {Math.round((maxT - minT) / 3600_000)}h</title>
      <path d={path} stroke="#0ea5e9" strokeWidth={1.5} fill="none" />
      <line
        x1={nowX}
        x2={nowX}
        y1={0}
        y2={H}
        stroke="#94a3b8"
        strokeWidth={0.8}
        strokeDasharray="2,2"
      />
    </svg>
  );
}
