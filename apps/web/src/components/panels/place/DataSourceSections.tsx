"use client";

import BusinessIcon from "@mui/icons-material/Business";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import ElectricScooterIcon from "@mui/icons-material/ElectricScooter";
import EvStationIcon from "@mui/icons-material/EvStation";
import InfoIcon from "@mui/icons-material/Info";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import TrainIcon from "@mui/icons-material/Train";
import VideocamIcon from "@mui/icons-material/Videocam";
import Box from "@mui/material/Box";
import Button from "@mui/material/Button";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
  buildRuntimeAttributionHtml,
  buildSourceAttribution,
  type DataSourceAttribution,
  type DataSourceDetail,
  type DataSourceDetailSection,
  pickIntegrationForSources,
  safeHref,
} from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { Translatable } from "@openmapx/integration-framework/strings";
import { useTranslations } from "next-intl";
import { Fragment, type ReactNode } from "react";
import { AttributionText } from "@/components/ui/AttributionText";
import { BRAND } from "@/lib/theme";
import { BrandMark } from "../shared/BrandMark";
import { type StructuredSection, StructuredSections } from "../shared/StructuredSections";
import { DataSourceNearbyTransit } from "./DataSourceNearbyTransit";
import { useDataSourceI18nResolver } from "./useDataSourceI18nResolver";

/** Section header config per data source type. */
const SOURCE_HEADERS: Record<string, { icon: ReactNode; titleKey: string }> = {
  // EV Charging
  "ev-charging": { icon: <EvStationIcon sx={{ fontSize: 20 }} />, titleKey: "evCharging" },
  ocm: { icon: <EvStationIcon sx={{ fontSize: 20 }} />, titleKey: "evCharging" },
  // Fuel
  fuel: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, titleKey: "fuelPrices" },
  "de-tankerkoenig": {
    icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />,
    titleKey: "fuelPrices",
  },
  france: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, titleKey: "fuelPrices" },
  spain: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, titleKey: "fuelPrices" },
  austria: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, titleKey: "fuelPrices" },
  // Bike Sharing
  "bike-sharing": { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, titleKey: "bikeSharing" },
  nextbike: { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, titleKey: "bikeSharing" },
  citybikes: { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, titleKey: "bikeSharing" },
  donkey: { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, titleKey: "bikeSharing" },
  // Scooter Sharing
  "scooter-sharing": {
    icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />,
    titleKey: "eScooterSharing",
  },
  felyx: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, titleKey: "eScooterSharing" },
  link: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, titleKey: "eScooterSharing" },
  "de-nw-mobidrom-scooter": {
    icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />,
    titleKey: "eScooterSharing",
  },
  // Car Sharing
  "car-sharing": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  "de-cambio": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  "de-stadtteilauto": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  "de-nw-wuppertal": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  "de-nw-bielefeld": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  // GBFS can be any type — will be resolved by prefix
  gbfs: { icon: <InfoIcon sx={{ fontSize: 20 }} />, titleKey: "sharedMobility" },
  // Parking
  parking: { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-parkapi-v2": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-parkapi-v3": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-db-bahnpark": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "nl-rdw": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "fr-bnls": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "be-vlg-ghent": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "be-bru-brussels": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "ch-bs-basel": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "it-52-florence": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "es-ct-barcelona": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "at-9-vienna": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "dk-84-copenhagen": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "sg-hdb": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "es-md-madrid": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "gb-eng-utmc": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "au-nsw": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "nl-ndw-truck": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-autobahn": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "it-32-opendatahub": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "ch-otd": {
    icon: <LocalParkingIcon sx={{ fontSize: 20 }} />,
    titleKey: "parking",
  },
  "lu-cita": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-nw-mobidrom": {
    icon: <LocalParkingIcon sx={{ fontSize: 20 }} />,
    titleKey: "parking",
  },
  "de-nw-mobidrom-pr": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-apcoa": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-apag": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "de-goldbeck": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  // DB Station (RIS::Stations)
  "db-station": { icon: <TrainIcon sx={{ fontSize: 20 }} />, titleKey: "dbStation" },
  // Webcam
  webcam: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  windy: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-ca-caltrans": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "gb-eng-tfl": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-nps": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-ny-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-or-tripcheck": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-ga-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-fl-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-az-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-id-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-ut-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-la-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-pa-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-sc-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "us-ma-511": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "fi-digitraffic-webcam": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "se-trafikverket": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "no-npra": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "is-road-administration": {
    icon: <VideocamIcon sx={{ fontSize: 20 }} />,
    titleKey: "webcams",
  },
  "es-dgt-webcam": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "ca-ontario": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "hk-transport": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "au-nsw-webcam": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "tw-tdx-webcam": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
};

function resolveSourceHeader(
  detail: DataSourceDetail,
  domain?: string,
): {
  icon: ReactNode;
  titleKey: string | null;
  titleFallback: string | null;
} {
  const primarySource = detail.sources[0] ?? "";

  // Try exact source match first
  const exactMatch = SOURCE_HEADERS[primarySource];
  if (exactMatch) return { ...exactMatch, titleFallback: null };

  // Try prefix (e.g., "tankerkoenig" from "tankerkoenig/uuid", "nextbike" from "nextbike/362/1234")
  const prefix = primarySource.split("/")[0];
  const prefixMatch = SOURCE_HEADERS[prefix];
  if (prefixMatch) return { ...prefixMatch, titleFallback: null };

  // Fall back to the calling integration's domain (e.g. "osm" source rendered
  // under the ev-charging / parking / webcam domain).
  if (domain) {
    const domainMatch = SOURCE_HEADERS[domain];
    if (domainMatch) return { ...domainMatch, titleFallback: null };
  }

  // Fallback: capitalize source name
  return {
    icon: <InfoIcon sx={{ fontSize: 20 }} />,
    titleKey: null,
    titleFallback: primarySource.charAt(0).toUpperCase() + primarySource.slice(1),
  };
}

interface Props {
  detail: DataSourceDetail;
  /** Integration/domain id (e.g. "ev-charging", "parking", "webcam") — used as
   * a fallback to resolve the section icon when the data source identifier is
   * generic (e.g. "osm"). */
  domain?: string;
}

function translateStructuredSection(
  section: DataSourceDetailSection,
  resolveT: (value: Translatable | undefined) => string,
): StructuredSection {
  const translatedTitle = resolveT(section.title);
  const translatedCaption = section.caption === undefined ? undefined : resolveT(section.caption);
  // A value cell may be a single Translatable or a list of them (e.g. a
  // localized accessory list); resolve each and join with the locale separator.
  const resolveCell = (cell: Translatable | Translatable[] | undefined): string | number =>
    Array.isArray(cell)
      ? cell.map((entry) => resolveT(entry)).join(", ")
      : typeof cell === "number"
        ? cell
        : resolveT(cell);
  const translatedRows: (string | number)[][] | undefined =
    section.type === "table" && section.rows?.every((row) => row.length === 2)
      ? section.rows.map(([label, value]) => [resolveT(label), resolveCell(value)])
      : section.rows?.map((row) => row.map((cell) => resolveCell(cell)));
  const translatedColumns = section.columns?.map((column) => resolveT(column));
  // Re-build the StructuredSection explicitly (no spread) so the narrowed
  // resolved field types win over `DataSourceDetailSection`'s wider
  // `I18nToken | string` slots.
  return {
    id: undefined,
    title: translatedTitle,
    caption: translatedCaption,
    captionTimestamp: section.captionTimestamp,
    links: section.links?.map((link) => ({ label: resolveT(link.label), url: link.url })),
    type: section.type,
    columns: translatedColumns,
    rows: translatedRows,
    items: section.items?.map((item) => resolveT(item)),
    content: section.content === undefined ? undefined : resolveT(section.content),
    imageUrl: section.imageUrl,
    imageAlt: section.imageAlt === undefined ? undefined : resolveT(section.imageAlt),
    linkUrl: section.linkUrl,
    embedUrl: section.embedUrl,
    embedType: section.embedType,
    sectionIcon: section.sectionIcon,
    pricingPlans: section.pricingPlans,
    collapsed: section.collapsed,
  };
}

function AttributionFooter({ detail }: { detail: DataSourceDetail }) {
  const registry = useIntegrationRegistry();

  // Resolve the producing integration. The host stamps `providerId`, which is
  // authoritative; fall back to the source-coverage heuristic only for details
  // that predate the stamp or come from outside the data-source orchestrator.
  // The heuristic ties when integrations share a generic sourceId like "osm"
  // (parking, ev-charging, etc.), so it must not override a known providerId.
  const meta =
    (detail.providerId ? registry.get(detail.providerId) : undefined) ??
    pickIntegrationForSources(registry.getByDomain("data-source"), detail.sources);
  const html = meta?.dataSources ? buildSourceAttribution(meta.dataSources, detail.sources) : "";
  const detailAttributions = detail.attributions ?? [];

  if (!html && detailAttributions.length === 0) return null;

  return (
    <Box sx={{ px: 2, py: 1.25 }}>
      <Typography
        variant="caption"
        component="div"
        sx={{
          color: "text.secondary",
        }}
      >
        {html && <AttributionText html={html} />}
        {detailAttributions.map((attribution, index) => (
          <Fragment key={detailAttributionKey(attribution)}>
            {(html || index > 0) && " · "}
            <AttributionText
              html={buildRuntimeAttributionHtml({
                text: attribution.text,
                url: attribution.url,
                license: attribution.license,
                licenseUrl: attribution.licenseUrl,
              })}
            />
          </Fragment>
        ))}
      </Typography>
    </Box>
  );
}

function detailAttributionKey(attribution: DataSourceAttribution): string {
  return [attribution.text, attribution.url, attribution.license, attribution.licenseUrl]
    .filter(Boolean)
    .join("|");
}

export function pickRentalActionUrl(
  action: NonNullable<NonNullable<DataSourceDetail["actions"]>["primaryRental"]>,
  userAgent: string,
): string | undefined {
  const web = safeHref(action.web);
  const ios = safeAppDeepLink(action.ios);
  const android = safeAppDeepLink(action.android);
  const platformUrl = /android/i.test(userAgent)
    ? android
    : /iphone|ipad|ipod/i.test(userAgent)
      ? ios
      : undefined;
  return platformUrl ?? web ?? ios ?? android;
}

const ALLOWED_DEEP_LINK_SCHEMES = new Set([
  "android",
  "app",
  "bird",
  "bolt",
  "dott",
  "donkey",
  "example",
  "example-android",
  "example-ios",
  "ios",
  "lime",
  "lyft",
  "nextbike",
  "tier",
  "uber",
  "voi",
]);

const REVERSE_DNS_DEEP_LINK_SCHEME = /^(?:com|net|org)\.[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/i;

/**
 * App deep links are the point of GBFS `rental_uris.ios` and `.android`, so
 * they cannot go through safeHref, which rejects every native scheme. Require
 * an authority-bearing scheme from the known app-scheme set or a reverse-DNS
 * app identifier; this excludes browser and local-state schemes by default.
 */
function safeAppDeepLink(uri: string | undefined): string | undefined {
  const trimmed = uri?.trim();
  const http = trimmed && /^(?:https?):\/\//i.test(trimmed) ? safeHref(trimmed) : undefined;
  if (http) return http;
  if (!trimmed) return undefined;
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(trimmed);
  if (!match) return undefined;
  const scheme = match[1].toLowerCase();
  return ALLOWED_DEEP_LINK_SCHEMES.has(scheme) || REVERSE_DNS_DEEP_LINK_SCHEME.test(scheme)
    ? trimmed
    : undefined;
}

export function DataSourceSections({ detail, domain }: Props) {
  const t = useTranslations("dataSources");
  const registry = useIntegrationRegistry();
  const meta = pickIntegrationForSources(registry.getByDomain("data-source"), detail.sources);
  // Scope token resolution to the integration that produced the detail. The
  // host stamps `providerId`; fall back to `domain` (this panel's owning
  // integration) before `meta` — `meta` is an attribution heuristic that ties
  // when sources share a generic prefix (e.g. "osm") and can pick an unrelated
  // integration, leaking raw token keys like `value.undergroundGarage`.
  const resolveT = useDataSourceI18nResolver(detail.providerId ?? domain ?? meta?.id);
  const header = resolveSourceHeader(detail, domain);
  const structuredSections = detail.sections.map((section) =>
    translateStructuredSection(section, resolveT),
  );
  const operatorLegalName =
    detail.operator?.legalName &&
    detail.operator.legalName !== detail.operator.name &&
    detail.operator.legalName !== detail.branding?.name
      ? detail.operator.legalName
      : null;
  const rentalUri = detail.actions?.primaryRental
    ? pickRentalActionUrl(
        detail.actions.primaryRental,
        typeof navigator === "undefined" ? "" : navigator.userAgent,
      )
    : undefined;

  return (
    <Box>
      <Divider sx={{ mx: 2, my: 1 }} />
      {/* Section header — like Transit section */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 2, pt: 1.5, pb: 0.5 }}>
        <Box sx={{ color: BRAND, display: "flex" }}>{header.icon}</Box>
        <Typography
          variant="subtitle2"
          sx={{
            fontWeight: 600,
            color: "text.primary",
          }}
        >
          {header.titleKey ? t(header.titleKey) : header.titleFallback}
        </Typography>
      </Box>
      {(rentalUri || detail.actions?.mapContext) && (
        <Box sx={{ display: "flex", gap: 1, px: 2, py: 1, flexWrap: "wrap" }}>
          {rentalUri && detail.actions?.primaryRental && (
            <Button
              variant="contained"
              component="a"
              href={rentalUri}
              target="_blank"
              rel="noopener noreferrer"
            >
              {resolveT(detail.actions.primaryRental.label)}
            </Button>
          )}
          {detail.actions?.mapContext && (
            <Button
              variant="outlined"
              onClick={() =>
                window.dispatchEvent(
                  new CustomEvent("openmapx:focus-data-source-context", {
                    detail: { contextId: detail.actions?.mapContext?.contextId },
                  }),
                )
              }
            >
              {resolveT(detail.actions.mapContext.label)}
            </Button>
          )}
        </Box>
      )}
      {/* Operator */}
      {detail.operator && (
        <Box sx={{ display: "flex", gap: 2, alignItems: "center", py: 1.25, px: 2 }}>
          {detail.branding ? (
            <BrandMark branding={detail.branding} fallbackName={detail.operator.name} size={34} />
          ) : (
            <Box sx={{ color: BRAND, flexShrink: 0, display: "flex" }}>
              <BusinessIcon />
            </Box>
          )}
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {detail.operator.url ? (
              <Link
                href={safeHref(detail.operator.url)}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                variant="body2"
                sx={{
                  color: "text.primary",
                  fontWeight: 600,
                }}
              >
                {detail.operator.name}
              </Link>
            ) : (
              <Typography
                variant="body2"
                sx={{
                  fontWeight: 600,
                }}
              >
                {detail.operator.name}
              </Typography>
            )}
            {operatorLegalName && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: "block",
                }}
              >
                {operatorLegalName}
              </Typography>
            )}
          </Box>
        </Box>
      )}
      {/* Usage info */}
      {detail.usageInfo && (
        <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start", py: 1.25, px: 2 }}>
          <Box sx={{ color: BRAND, flexShrink: 0, display: "flex", mt: 0.25 }}>
            <LockOpenIcon />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography variant="body2">{resolveT(detail.usageInfo.type)}</Typography>
            {detail.usageInfo.cost && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                }}
              >
                {resolveT(detail.usageInfo.cost)}
              </Typography>
            )}
            {detail.usageInfo.membershipRequired && (
              <Typography
                variant="caption"
                sx={{
                  color: "text.secondary",
                  display: "block",
                }}
              >
                {t("membershipRequiredLabel")}
              </Typography>
            )}
          </Box>
        </Box>
      )}
      {/* Dynamic sections (connectors, etc.) */}
      {structuredSections.length > 0 && (
        <StructuredSections
          sections={structuredSections}
          pricingLabels={{
            standard: t("pricingStandardPlan"),
            unlockFee: t("pricingUnlockFee"),
            perKm: t("pricingPerKm"),
            perHour: t("pricingPerHour"),
            free: t("pricingFree"),
          }}
        />
      )}
      {/* Park+Ride: list nearby transit lines. Silent when no routes found. */}
      {detail.parkAndRide && <DataSourceNearbyTransit coordinates={detail.coordinates} />}
      {/* Attribution footer */}
      <Divider sx={{ mx: 2 }} />
      <AttributionFooter detail={detail} />
    </Box>
  );
}
