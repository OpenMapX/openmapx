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
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
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
import { TEAL } from "@/lib/theme";
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
  tankerkoenig: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, titleKey: "fuelPrices" },
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
  "nrw-mobidrom-scooter": {
    icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />,
    titleKey: "eScooterSharing",
  },
  // Car Sharing
  "car-sharing": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  cambio: { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  stadtteilauto: { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  wuppertal: { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  bielefeld: { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, titleKey: "carSharing" },
  // GBFS can be any type — will be resolved by prefix
  gbfs: { icon: <InfoIcon sx={{ fontSize: 20 }} />, titleKey: "sharedMobility" },
  // Parking
  parking: { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "parkapi-v2": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "parkapi-v3": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "db-bahnpark": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "rdw-nl": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "bnls-fr": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "ghent-be": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "brussels-be": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "basel-ch": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "florence-it": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "barcelona-es": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "vienna-at": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "copenhagen-dk": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  singapore: { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "madrid-es": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "utmc-newcastle": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "nsw-au": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "ndw-truck-nl": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "autobahn-de": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "opendatahub-it": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "opentransportdata-ch-parking": {
    icon: <LocalParkingIcon sx={{ fontSize: 20 }} />,
    titleKey: "parking",
  },
  "cita-lu": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "nrw-mobidrom-parking": {
    icon: <LocalParkingIcon sx={{ fontSize: 20 }} />,
    titleKey: "parking",
  },
  "nrw-mobidrom-pr": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  apcoa: { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  apag: { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  goldbeck: { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  // DB Station (RIS::Stations)
  "db-station": { icon: <TrainIcon sx={{ fontSize: 20 }} />, titleKey: "dbStation" },
  // Webcam
  webcam: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  windy: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  caltrans: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  tfl: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  nps: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-ny": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-or": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-ga": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-fl": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-az": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-id": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-ut": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-la": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-pa": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-sc": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "dot-ma": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
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
  const tc = useTranslations("common");
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
        {tc("data")}:{" "}
        {html && (
          <Box
            component="span"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: attribution HTML from trusted integration manifests
            dangerouslySetInnerHTML={{ __html: html }}
          />
        )}
        {detailAttributions.map((attribution, index) => (
          <Fragment key={detailAttributionKey(attribution)}>
            {(html || index > 0) && " · "}
            <DetailAttribution attribution={attribution} />
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

function safeExternalUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? url : undefined;
  } catch {
    return undefined;
  }
}

function DetailAttribution({ attribution }: { attribution: DataSourceAttribution }) {
  const providerUrl = safeExternalUrl(attribution.url);
  const licenseUrl = safeExternalUrl(attribution.licenseUrl);

  return (
    <Box component="span">
      ©{" "}
      {providerUrl ? (
        <Link
          href={safeHref(providerUrl)}
          target="_blank"
          rel="noopener noreferrer"
          color="inherit"
        >
          {attribution.text}
        </Link>
      ) : (
        attribution.text
      )}
      {attribution.license &&
        (licenseUrl ? (
          <>
            {" "}
            (
            <Link
              href={safeHref(licenseUrl)}
              target="_blank"
              rel="noopener noreferrer"
              color="inherit"
            >
              {attribution.license}
            </Link>
            )
          </>
        ) : (
          ` (${attribution.license})`
        ))}
    </Box>
  );
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

  return (
    <Box>
      <Divider sx={{ mx: 2, my: 1 }} />
      {/* Section header — like Transit section */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 2, pt: 1.5, pb: 0.5 }}>
        <Box sx={{ color: TEAL, display: "flex" }}>{header.icon}</Box>
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
      {/* Operator */}
      {detail.operator && (
        <Box sx={{ display: "flex", gap: 2, alignItems: "center", py: 1.25, px: 2 }}>
          {detail.branding ? (
            <BrandMark branding={detail.branding} fallbackName={detail.operator.name} size={34} />
          ) : (
            <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>
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
          <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: 0.25 }}>
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
