"use client";

import FlightTakeoffIcon from "@mui/icons-material/FlightTakeoff";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import LanguageIcon from "@mui/icons-material/Language";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type {
  AirportFrequencyInfo,
  AirportInfo,
  AirportNavaidInfo,
  AirportRunwayInfo,
  AirportType,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { TEAL } from "@/lib/theme";
import { SectionLabel } from "../shared/SectionLabel";
import { useDataSourceAttribution } from "./useDataSourceAttribution";

const FT_TO_M = 0.3048;

interface Props {
  airport: AirportInfo;
}

export function PlaceAirportInfo({ airport }: Props) {
  const t = useTranslations("airport");
  const hasRunways = (airport.runways?.length ?? 0) > 0;
  const hasFrequencies = (airport.frequencies?.length ?? 0) > 0;
  const hasNavaids = (airport.navaids?.length ?? 0) > 0;
  const ourAirportsUrl = `https://ourairports.com/airports/${encodeURIComponent(airport.ident)}/`;

  // Source attribution is pulled from the integration manifest rather than
  // hardcoded so a name/license/URL update in `manifest.json` flows through
  // every airport panel automatically.
  const attributionSource = useDataSourceAttribution("knowledge-ourairports", "ourairports");

  return (
    <Box>
      <Divider sx={{ mx: 2, my: 1 }} />
      {/* Header */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 2, pt: 1.5, pb: 0.5 }}>
        <Box sx={{ color: TEAL, display: "flex" }}>
          <FlightTakeoffIcon sx={{ fontSize: 20 }} />
        </Box>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            color: "text.primary",
          }}
        >
          {t("section")}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography
          variant="caption"
          sx={{
            color: "text.secondary",
          }}
        >
          {translateAirportType(airport.type, t)}
        </Typography>
      </Box>
      {/* Identifiers */}
      <Box sx={{ display: "flex", gap: 0.75, flexWrap: "wrap", px: 2, pt: 0.5, pb: 1 }}>
        {airport.iata && <CodeChip label={t("iata")} value={airport.iata} tone="primary" />}
        {airport.icao && airport.icao !== airport.iata && (
          <CodeChip label={t("icao")} value={airport.icao} tone="secondary" />
        )}
        {!airport.iata && !airport.icao && airport.ident && (
          <CodeChip label={t("icao")} value={airport.ident} tone="secondary" />
        )}
      </Box>
      {/* Key facts grid */}
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)",
          rowGap: 1,
          columnGap: 1,
          px: 2,
          pb: 1.25,
        }}
      >
        {airport.elevationFt !== undefined && (
          <FactCell
            label={t("elevation")}
            value={t("elevationValue", {
              ft: airport.elevationFt,
              m: Math.round(airport.elevationFt * FT_TO_M),
            })}
          />
        )}
        <FactCell
          label={t("scheduledService")}
          value={airport.scheduledService ? t("scheduledServiceYes") : t("scheduledServiceNo")}
          muted={!airport.scheduledService}
        />
        {airport.municipality && <FactCell label={t("country")} value={formatLocation(airport)} />}
      </Box>
      {/* Links row */}
      {(airport.homeLink || airport.wikipediaLink) && (
        <Box
          sx={{
            display: "flex",
            flexWrap: "wrap",
            gap: 1.5,
            px: 2,
            pb: 1,
            alignItems: "center",
          }}
        >
          {airport.homeLink && (
            <LinkRow icon={<LanguageIcon sx={{ fontSize: 16 }} />} href={airport.homeLink}>
              {t("officialSite")}
            </LinkRow>
          )}
          <LinkRow icon={<OpenInNewIcon sx={{ fontSize: 16 }} />} href={ourAirportsUrl}>
            {t("ourAirportsPage")}
          </LinkRow>
        </Box>
      )}
      {/* Runways */}
      {hasRunways && (
        <>
          <SectionHeader title={t("runways")} />
          <Box sx={{ px: 2, pb: 1 }}>
            {airport.runways?.map((rw) => (
              <RunwayRow
                key={rw.ident}
                runway={rw}
                surfaceLabel={translateSurface(rw.surface, t)}
              />
            ))}
          </Box>
        </>
      )}
      {/* Frequencies */}
      {hasFrequencies && (
        <>
          <SectionHeader title={t("frequencies")} />
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(72px, max-content) minmax(0, 1fr) max-content",
              columnGap: 1.25,
              rowGap: 0.5,
              px: 2,
              pb: 1,
              alignItems: "baseline",
            }}
          >
            {airport.frequencies?.map((f) => (
              <FrequencyRow
                key={`${f.type}-${f.frequencyMhz}-${f.description ?? ""}`}
                freq={f}
                typeLabel={translateFreqType(f.type, t)}
              />
            ))}
          </Box>
        </>
      )}
      {/* Navaids */}
      {hasNavaids && (
        <>
          <SectionHeader title={t("navaids")} />
          <Box
            sx={{
              display: "grid",
              gridTemplateColumns: "minmax(56px, max-content) minmax(0, 1fr) max-content",
              columnGap: 1.25,
              rowGap: 0.5,
              px: 2,
              pb: 1,
              alignItems: "baseline",
            }}
          >
            {airport.navaids?.map((n) => (
              <NavaidRow key={`${n.ident}-${n.type}-${n.frequencyKhz ?? ""}`} navaid={n} t={t} />
            ))}
          </Box>
        </>
      )}
      {/* Disclaimer */}
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          gap: 0.75,
          px: 2,
          pt: 1,
          pb: 0.25,
          color: "text.secondary",
        }}
      >
        <InfoOutlinedIcon sx={{ fontSize: 14 }} />
        <Typography variant="caption">{t("informationalDisclaimer")}</Typography>
      </Box>
      {/* Attribution — sourced from the integration manifest, same pattern as PlaceSunTimes. */}
      {attributionSource && (
        <Box sx={{ px: 2, pt: 0, pb: 1 }}>
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {t("attribution")}: ©{" "}
            <Link
              href={attributionSource.url}
              target="_blank"
              rel="noopener noreferrer"
              underline="hover"
              color="inherit"
            >
              {attributionSource.name}
            </Link>
            {attributionSource.license && (
              <>
                {" ("}
                {attributionSource.licenseUrl ? (
                  <Link
                    href={attributionSource.licenseUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    underline="hover"
                    color="inherit"
                  >
                    {attributionSource.license}
                  </Link>
                ) : (
                  attributionSource.license
                )}
                {")"}
              </>
            )}
          </Typography>
        </Box>
      )}
    </Box>
  );
}

function SectionHeader({ title }: { title: string }) {
  return (
    <Box sx={{ px: 2, pt: 0.5 }}>
      <SectionLabel>{title}</SectionLabel>
    </Box>
  );
}

function CodeChip({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "primary" | "secondary";
}) {
  return (
    <Chip
      size="small"
      sx={{
        height: 26,
        fontFamily:
          "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
        fontWeight: 700,
        letterSpacing: 0.5,
        borderRadius: 1,
        bgcolor: tone === "primary" ? "rgba(0, 128, 128, 0.12)" : "action.hover",
        color: tone === "primary" ? TEAL : "text.primary",
        border: 1,
        borderColor: tone === "primary" ? "rgba(0, 128, 128, 0.35)" : "divider",
        "& .MuiChip-label": {
          px: 0.75,
          display: "flex",
          alignItems: "baseline",
          gap: 0.5,
        },
      }}
      label={
        <>
          <Box
            component="span"
            sx={{
              fontSize: 9.5,
              fontWeight: 600,
              opacity: 0.7,
              letterSpacing: 0.6,
            }}
          >
            {label}
          </Box>
          <Box component="span" sx={{ fontSize: 12.5 }}>
            {value}
          </Box>
        </>
      }
    />
  );
}

function FactCell({ label, value, muted }: { label: string; value: string; muted?: boolean }) {
  return (
    <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
        }}
      >
        {label}
      </Typography>
      <Typography
        variant="body2"
        color={muted ? "text.secondary" : "text.primary"}
        sx={{ wordBreak: "break-word" }}
      >
        {value}
      </Typography>
    </Box>
  );
}

function LinkRow({
  icon,
  href,
  children,
}: {
  icon: React.ReactNode;
  href: string;
  children: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      underline="hover"
      variant="body2"
      sx={{
        display: "inline-flex",
        alignItems: "center",
        gap: 0.5,
        color: "text.primary",
      }}
    >
      <Box component="span" sx={{ color: "text.secondary", display: "flex" }}>
        {icon}
      </Box>
      {children}
    </Link>
  );
}

function RunwayRow({
  runway,
  surfaceLabel,
}: {
  runway: AirportRunwayInfo;
  surfaceLabel: string | null;
}) {
  const t = useTranslations("airport");
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: "minmax(72px, max-content) 1fr max-content",
        alignItems: "center",
        columnGap: 1.5,
        py: 0.5,
        opacity: runway.closed ? 0.55 : 1,
      }}
    >
      <Box
        component="span"
        sx={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontWeight: 700,
          fontSize: 13.5,
          color: "text.primary",
          letterSpacing: 0.3,
        }}
      >
        {runway.ident}
      </Box>
      <Box sx={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <Typography
          variant="body2"
          sx={{
            color: "text.primary",
          }}
        >
          {formatRunwayDimensions(runway, t)}
        </Typography>
        {surfaceLabel && (
          <Typography
            variant="caption"
            sx={{
              color: "text.secondary",
            }}
          >
            {surfaceLabel}
          </Typography>
        )}
      </Box>
      <Box sx={{ display: "flex", gap: 0.5, justifySelf: "end" }}>
        {runway.closed ? (
          <StatusChip text={t("runwayClosed")} tone="warn" />
        ) : runway.lighted ? (
          <StatusChip text={t("runwayLighted")} tone="info" />
        ) : null}
      </Box>
    </Box>
  );
}

function FrequencyRow({ freq, typeLabel }: { freq: AirportFrequencyInfo; typeLabel: string }) {
  const t = useTranslations("airport");
  return (
    <>
      <Box
        component="span"
        sx={{
          fontWeight: 600,
          fontSize: 12,
          color: "text.primary",
          textTransform: "uppercase",
          letterSpacing: 0.3,
        }}
      >
        {typeLabel}
      </Box>
      <Typography
        variant="caption"
        title={freq.description ?? undefined}
        sx={{
          color: "text.secondary",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {freq.description ?? "—"}
      </Typography>
      <Box
        component="span"
        sx={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontVariantNumeric: "tabular-nums",
          fontWeight: 600,
          fontSize: 12.5,
          color: "text.primary",
        }}
      >
        {t("frequencyValue", { mhz: freq.frequencyMhz })}
      </Box>
    </>
  );
}

function NavaidRow({
  navaid,
  t,
}: {
  navaid: AirportNavaidInfo;
  t: ReturnType<typeof useTranslations>;
}) {
  const isVhf = !navaid.type.startsWith("NDB");
  const frequencyDisplay = formatNavaidFrequency(navaid, t, isVhf);
  return (
    <>
      <Box
        component="span"
        sx={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontWeight: 700,
          fontSize: 12.5,
          color: "text.primary",
        }}
      >
        {navaid.ident}
      </Box>
      <Typography
        variant="caption"
        sx={{
          color: "text.secondary",
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {[navaid.name, navaid.type].filter(Boolean).join(" · ")}
      </Typography>
      <Box
        component="span"
        sx={{
          fontFamily:
            "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
          fontVariantNumeric: "tabular-nums",
          fontSize: 12,
          color: "text.secondary",
        }}
      >
        {frequencyDisplay ?? ""}
      </Box>
    </>
  );
}

function StatusChip({ text, tone }: { text: string; tone: "info" | "warn" }) {
  return (
    <Box
      component="span"
      sx={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        py: 0.25,
        px: 0.75,
        borderRadius: 0.75,
        bgcolor: tone === "warn" ? "warning.softBg" : "action.hover",
        color: tone === "warn" ? "warning.main" : "text.secondary",
        border: 1,
        borderColor: tone === "warn" ? "warning.main" : "divider",
        whiteSpace: "nowrap",
      }}
    >
      {text}
    </Box>
  );
}

function formatRunwayDimensions(
  runway: AirportRunwayInfo,
  t: ReturnType<typeof useTranslations>,
): string {
  if (runway.lengthFt && runway.widthFt) {
    return t("runwayDimensions", { length: runway.lengthFt, width: runway.widthFt });
  }
  if (runway.lengthFt) {
    return t("runwayLengthOnly", { length: runway.lengthFt });
  }
  return "—";
}

function translateAirportType(type: AirportType, t: ReturnType<typeof useTranslations>): string {
  const key = `type_${type}` as const;
  return t(key);
}

function translateSurface(
  surface: string | undefined,
  t: ReturnType<typeof useTranslations>,
): string | null {
  if (!surface) return null;
  const upper = surface.toUpperCase();
  const knownKeys = new Set([
    "ASP",
    "CON",
    "PEM",
    "TURF",
    "GRS",
    "GRE",
    "GRVL",
    "DIRT",
    "WATER",
    "UNK",
  ]);
  if (knownKeys.has(upper)) {
    return t(`surface_${upper}` as `surface_ASP`);
  }
  return t("surface_other", { value: surface });
}

function translateFreqType(type: string, t: ReturnType<typeof useTranslations>): string {
  const upper = type.toUpperCase();
  const known = new Set([
    "TWR",
    "GND",
    "CLD",
    "DEL",
    "APP",
    "ARR",
    "DEP",
    "CTAF",
    "UNICOM",
    "ATIS",
    "AWOS",
    "ASOS",
    "RMP",
    "RCO",
    "RDO",
    "ATF",
  ]);
  if (known.has(upper)) {
    return t(`freqType_${upper}` as `freqType_TWR`);
  }
  return upper;
}

function formatNavaidFrequency(
  navaid: AirportNavaidInfo,
  t: ReturnType<typeof useTranslations>,
  isVhf: boolean,
): string | null {
  if (navaid.frequencyKhz === undefined) return null;
  if (isVhf) {
    return t("navaidFrequencyVhf", { mhz: navaid.frequencyKhz / 1000 });
  }
  return t("navaidFrequencyNdb", { khz: navaid.frequencyKhz });
}

function formatLocation(airport: AirportInfo): string {
  const parts = [airport.municipality, airport.isoRegion ?? airport.isoCountry].filter(Boolean);
  return parts.join(" · ");
}
