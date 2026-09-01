"use client";

import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import KeyboardArrowDownIcon from "@mui/icons-material/KeyboardArrowDown";
import KeyboardArrowUpIcon from "@mui/icons-material/KeyboardArrowUp";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type {
  MetObservation,
  TideCurvePoint,
  TideEvent,
  TidesResponse,
  WaterLevelObservation,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { SectionAttribution } from "@/components/ui/SectionAttribution";
import { useDateTimeFormat } from "@/integration-api/runtime/useDateTimeFormat";
import { SectionLabel } from "../shared/SectionLabel";
import { useDataSourceAttribution } from "./useDataSourceAttribution";

/**
 * Presentation-only tide content. Mounted inside an `ExpandableDetailRow`
 * in `PlaceOverviewTab` (mirroring the weather + sunrise rows). The hook
 * call and "no nearby station" gating happen in the parent so the whole
 * row can be hidden for inland users instead of just collapsing empty.
 */
export function PlaceTidesContent({ data }: { data: TidesResponse }) {
  const t = useTranslations("tides");
  // Attribution must reflect the provider that actually answered: NOAA covers
  // US coasts, but Canada/Norway/Pegelonline/IOC each have their own license
  // terms and crediting NOAA for their data is wrong. `useTides` stamps the
  // winning provider onto the response so the panel can pull the matching
  // manifest entry here.
  const attributionSource = useDataSourceAttribution(
    data.provider.integrationId,
    data.provider.sourceId,
  );

  const now = Date.now();
  const enriched = data.events.map((e) => ({ ...e, parsed: parseLocalTime(e.time) }));
  const upcoming = enriched.filter((e) => e.parsed.getTime() > now);
  const nextHigh = upcoming.find((e) => e.type === "H") ?? null;
  const nextLow = upcoming.find((e) => e.type === "L") ?? null;

  const today = todayLocalDate();
  const tomorrow = addDays(today, 1);
  const todayKey = isoDate(today);
  const tomorrowKey = isoDate(tomorrow);

  const eventsToday = enriched.filter((e) => isoDate(e.parsed) === todayKey);
  const eventsTomorrow = enriched.filter((e) => isoDate(e.parsed) === tomorrowKey);

  return (
    <Box sx={{ py: 1 }}>
      {/* Headline: current observed level (if available) + next high/low */}
      <Box sx={{ display: "flex", gap: 3, flexWrap: "wrap", alignItems: "flex-start" }}>
        {data.currentLevel && (
          <CurrentLevelBlock
            level={data.currentLevel}
            nextHigh={nextHigh}
            nextLow={nextLow}
            t={t}
          />
        )}
        {nextHigh && <NextEventBlock label={t("nextHigh")} event={nextHigh} t={t} />}
        {nextLow && <NextEventBlock label={t("nextLow")} event={nextLow} t={t} />}
      </Box>
      {/* Met readings — wind / temp / pressure */}
      {data.met && <MetBlock met={data.met} t={t} />}
      {/* Inline 24h SVG chart */}
      {data.curve && data.curve.length > 1 && (
        <TideChart
          curve={data.curve}
          events={enriched}
          currentLevel={data.currentLevel}
          now={now}
          t={t}
        />
      )}
      {/* Today + tomorrow schedule */}
      {eventsToday.length > 0 && (
        <DaySection title={t("todayTitle")} events={eventsToday} now={now} t={t} />
      )}
      {eventsTomorrow.length > 0 && (
        <DaySection title={t("tomorrowTitle")} events={eventsTomorrow} now={now} t={t} />
      )}
      {/* Station label — hide the "(0.0 km)" suffix when the place IS the
          station (e.g. clicking a station marker directly), since the distance
          would round to zero and just adds noise. 50 m feels like a sensible
          threshold for "you're standing on the station". */}
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          mt: 0.75,
          display: "block",
        }}
      >
        {data.station.distanceKm < 0.05
          ? t("stationLabelHere", { name: data.station.name })
          : t("stationLabel", { name: data.station.name, distance: data.station.distanceKm })}
      </Typography>
      {/* Disclaimer */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          mt: 0.25,
          color: "text.secondary",
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 14 }} />
        <Typography variant="caption">{t("informationalDisclaimer")}</Typography>
      </Box>
      {/* Attribution — rendered via the shared builder (SectionAttribution). */}
      {attributionSource && (
        <>
          <SectionAttribution
            name={attributionSource.name}
            url={attributionSource.url}
            license={attributionSource.license}
            licenseUrl={attributionSource.licenseUrl}
            attribution={attributionSource.attribution}
          />
          <Typography variant="caption" sx={{ color: "text.secondary", display: "block" }}>
            {t("datumNote")}
          </Typography>
        </>
      )}
    </Box>
  );
}

function NextEventBlock({
  label,
  event,
  t,
}: {
  label: string;
  event: TideEvent & { parsed: Date };
  t: ReturnType<typeof useTranslations>;
}) {
  const isHigh = event.type === "H";
  const Icon = isHigh ? KeyboardArrowUpIcon : KeyboardArrowDownIcon;
  const fmt = useDateTimeFormat();
  return (
    <Box>
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{label}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
        <Icon sx={{ fontSize: 18, color: isHigh ? "success.main" : "text.secondary" }} />
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>{fmt.time(event.parsed)}</Typography>
      </Box>
      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
        {t("heightFt", { ft: event.valueFt })}
      </Typography>
    </Box>
  );
}

function DaySection({
  title,
  events,
  now,
  t,
}: {
  title: string;
  events: Array<TideEvent & { parsed: Date }>;
  now: number;
  t: ReturnType<typeof useTranslations>;
}) {
  return (
    <Box sx={{ mt: 0.75 }}>
      <SectionLabel>{title}</SectionLabel>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "max-content minmax(0, 1fr) max-content",
          columnGap: 1.25,
          rowGap: 0.25,
          alignItems: "baseline",
          mt: 0.25,
        }}
      >
        {events.map((e) => (
          <EventRow key={`${e.time}-${e.type}`} event={e} isPast={e.parsed.getTime() < now} t={t} />
        ))}
      </Box>
    </Box>
  );
}

function EventRow({
  event,
  isPast,
  t,
}: {
  event: TideEvent & { parsed: Date };
  isPast: boolean;
  t: ReturnType<typeof useTranslations>;
}) {
  const isHigh = event.type === "H";
  const fmt = useDateTimeFormat();
  return (
    <>
      <Box
        component="span"
        sx={{
          display: "inline-flex",
          alignItems: "center",
          gap: 0.25,
          color: isPast ? "text.disabled" : isHigh ? "success.main" : "text.secondary",
          fontSize: 12,
          fontWeight: 600,
        }}
      >
        {isHigh ? (
          <KeyboardArrowUpIcon sx={{ fontSize: 14 }} />
        ) : (
          <KeyboardArrowDownIcon sx={{ fontSize: 14 }} />
        )}
        {isHigh ? t("high") : t("low")}
      </Box>
      <Box
        component="span"
        sx={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontVariantNumeric: "tabular-nums",
          fontSize: 12.5,
          color: isPast ? "text.disabled" : "text.primary",
        }}
      >
        {fmt.time(event.parsed)}
      </Box>
      <Box
        component="span"
        sx={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontVariantNumeric: "tabular-nums",
          fontSize: 12,
          color: isPast ? "text.disabled" : "text.secondary",
          justifySelf: "end",
        }}
      >
        {t("heightFt", { ft: event.valueFt })}
      </Box>
    </>
  );
}

function CurrentLevelBlock({
  level,
  nextHigh,
  nextLow,
  t,
}: {
  level: WaterLevelObservation;
  nextHigh: (TideEvent & { parsed: Date }) | null;
  nextLow: (TideEvent & { parsed: Date }) | null;
  t: ReturnType<typeof useTranslations>;
}) {
  // Rising vs. falling — compare the current value against the next event:
  // if the next event is a High and is later than the next Low (or no Low),
  // the water is rising; otherwise falling. Heuristic only — accurate enough
  // for a single arrow indicator without re-deriving from the curve.
  let trend: "rising" | "falling" | null = null;
  if (nextHigh && nextLow) {
    trend = nextHigh.parsed.getTime() < nextLow.parsed.getTime() ? "rising" : "falling";
  } else if (nextHigh) {
    trend = "rising";
  } else if (nextLow) {
    trend = "falling";
  }
  const Icon = trend === "rising" ? KeyboardArrowUpIcon : KeyboardArrowDownIcon;
  const preliminary = level.quality === "p";
  return (
    <Box>
      <Typography sx={{ fontSize: 12, color: "text.secondary" }}>{t("currentLevel")}</Typography>
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.25 }}>
        {trend && (
          <Icon
            sx={{
              fontSize: 18,
              color: trend === "rising" ? "success.main" : "text.secondary",
            }}
          />
        )}
        <Typography sx={{ fontWeight: 600, fontSize: 16 }}>
          {t("heightFt", { ft: level.valueFt })}
        </Typography>
      </Box>
      {trend && (
        <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
          {t(trend)}
          {preliminary ? ` · ${t("preliminary")}` : ""}
        </Typography>
      )}
    </Box>
  );
}

const CARDINALS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];

function windDirection(deg: number): string {
  const idx = Math.round((deg % 360) / 45) % 8;
  return CARDINALS[idx] ?? "";
}

function MetBlock({ met, t }: { met: MetObservation; t: ReturnType<typeof useTranslations> }) {
  const parts: string[] = [];
  if (met.windKnots !== undefined) {
    const dir = met.windDirDeg !== undefined ? windDirection(met.windDirDeg) : "";
    parts.push(
      met.windGustKnots !== undefined
        ? t("windWithGust", { speed: met.windKnots, gust: met.windGustKnots, dir })
        : t("windKnots", { speed: met.windKnots, dir }),
    );
  }
  if (met.waterTempF !== undefined) parts.push(t("waterTempF", { temp: met.waterTempF }));
  if (met.airTempF !== undefined) parts.push(t("airTempF", { temp: met.airTempF }));
  if (met.pressureMb !== undefined) parts.push(t("pressureMb", { mb: met.pressureMb }));
  if (parts.length === 0) return null;
  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
        {t("metTitle")}
      </Typography>
      <Typography variant="body2" sx={{ fontSize: 12, color: "text.primary" }}>
        {parts.join(" · ")}
      </Typography>
    </Box>
  );
}

const CHART_W = 280;
const CHART_H = 90;
const CHART_PAD_X = 6;
const CHART_PAD_Y = 14;

function TideChart({
  curve,
  events,
  currentLevel,
  now,
  t,
}: {
  curve: TideCurvePoint[];
  events: Array<TideEvent & { parsed: Date }>;
  currentLevel?: WaterLevelObservation;
  now: number;
  t: ReturnType<typeof useTranslations>;
}) {
  if (curve.length < 2) return null;
  // Window the curve to a 24h slice centred on "now" so the chart is
  // legible regardless of how wide a window NOAA returned.
  const halfWindowMs = 12 * 60 * 60 * 1000;
  const windowStart = now - halfWindowMs;
  const windowEnd = now + halfWindowMs;
  const points = curve
    .map((p) => ({ t: parseLocalTime(p.time).getTime(), v: p.valueFt }))
    .filter((p) => p.t >= windowStart && p.t <= windowEnd);
  if (points.length < 2) return null;

  const minV = Math.min(...points.map((p) => p.v));
  const maxV = Math.max(...points.map((p) => p.v));
  const vRange = Math.max(0.5, maxV - minV);
  const innerW = CHART_W - CHART_PAD_X * 2;
  const innerH = CHART_H - CHART_PAD_Y * 2;
  const xFor = (t: number) =>
    CHART_PAD_X + ((t - windowStart) / (windowEnd - windowStart)) * innerW;
  const yFor = (v: number) => CHART_PAD_Y + ((maxV - v) / vRange) * innerH;

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${xFor(p.t).toFixed(1)} ${yFor(p.v).toFixed(1)}`)
    .join(" ");
  // Closed area path for the soft fill underneath.
  const area = `${path} L${xFor(points[points.length - 1].t).toFixed(1)} ${(
    CHART_PAD_Y + innerH
  ).toFixed(1)} L${xFor(points[0].t).toFixed(1)} ${(CHART_PAD_Y + innerH).toFixed(1)} Z`;

  const visibleEvents = events.filter(
    (e) => e.parsed.getTime() >= windowStart && e.parsed.getTime() <= windowEnd,
  );

  return (
    <Box sx={{ mt: 1 }}>
      <Typography variant="caption" sx={{ color: "text.secondary", fontWeight: 600 }}>
        {t("chartTitle")}
      </Typography>
      <Box sx={{ mt: 0.25 }}>
        <svg
          width={CHART_W}
          height={CHART_H}
          viewBox={`0 0 ${CHART_W} ${CHART_H}`}
          role="img"
          aria-label={t("chartTitle")}
        >
          <path d={area} fill="rgba(14, 165, 233, 0.15)" />
          <path d={path} fill="none" stroke="#0284c7" strokeWidth={1.5} />
          {/* H/L event markers */}
          {visibleEvents.map((e) => (
            <circle
              key={`${e.time}-${e.type}`}
              cx={xFor(e.parsed.getTime())}
              cy={yFor(e.valueFt)}
              r={2.2}
              fill={e.type === "H" ? "#16a34a" : "#94a3b8"}
              stroke="#fff"
              strokeWidth={1}
            />
          ))}
          {/* "Now" vertical line */}
          <line
            x1={xFor(now)}
            x2={xFor(now)}
            y1={CHART_PAD_Y}
            y2={CHART_PAD_Y + innerH}
            stroke="#0f172a"
            strokeWidth={0.75}
            strokeDasharray="2 2"
          />
          {/* Current observed level dot */}
          {currentLevel && (
            <circle
              cx={xFor(now)}
              cy={yFor(currentLevel.valueFt)}
              r={3}
              fill="#0f172a"
              stroke="#fff"
              strokeWidth={1}
            />
          )}
        </svg>
      </Box>
    </Box>
  );
}

/**
 * Parse a tide-event timestamp. Two formats are supported:
 *
 * - NOAA's `lst_ldt` form `YYYY-MM-DD HH:mm` — already in the station's local
 *   zone, with no offset marker. We treat it as wall-clock in the browser
 *   zone (US coastal users are usually in the station's zone).
 * - ISO-8601 with explicit offset, e.g. Canada's `2026-05-18T03:20:00Z` —
 *   parsed via the standard `Date` constructor and displayed in the user's
 *   browser-local time. Without this branch the Z-suffixed string would fall
 *   into the wall-clock path and shift events by the user's UTC offset.
 */
function parseLocalTime(timeStr: string): Date {
  if (/T\d{2}:\d{2}/.test(timeStr) && /Z|[+-]\d{2}:?\d{2}$/.test(timeStr)) {
    return new Date(timeStr);
  }
  const [datePart, timePart = "00:00"] = timeStr.split(" ");
  const [y, m, d] = datePart.split("-").map(Number);
  const [hh, mm] = timePart.split(":").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0);
}

function todayLocalDate(): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}
