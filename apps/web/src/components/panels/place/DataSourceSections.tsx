"use client";

import AccessTimeIcon from "@mui/icons-material/AccessTime";
import BoltIcon from "@mui/icons-material/Bolt";
import BusinessIcon from "@mui/icons-material/Business";
import DirectionsBusIcon from "@mui/icons-material/DirectionsBus";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import ElectricScooterIcon from "@mui/icons-material/ElectricScooter";
import EnergySavingsLeafIcon from "@mui/icons-material/EnergySavingsLeaf";
import EvStationIcon from "@mui/icons-material/EvStation";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import InfoIcon from "@mui/icons-material/Info";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import LocalParkingIcon from "@mui/icons-material/LocalParking";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import PaymentsIcon from "@mui/icons-material/Payments";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import TrainIcon from "@mui/icons-material/Train";
import VideocamIcon from "@mui/icons-material/Videocam";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import {
  buildSourceAttribution,
  type DataSourceDetail,
  type DataSourceDetailSection,
  extractSourcePrefix,
  useIntegrationRegistry,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import { type ReactNode, useState } from "react";
import { HlsVideo } from "@/components/ui/HlsVideo";
import { TEAL } from "@/lib/theme";

/** Section header config per data source type. */
const SOURCE_HEADERS: Record<string, { icon: ReactNode; titleKey: string }> = {
  // EV Charging
  "ev-charging": { icon: <EvStationIcon sx={{ fontSize: 20 }} />, titleKey: "evCharging" },
  ocm: { icon: <EvStationIcon sx={{ fontSize: 20 }} />, titleKey: "evCharging" },
  "osm-ev": { icon: <EvStationIcon sx={{ fontSize: 20 }} />, titleKey: "evCharging" },
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
  gosharing: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, titleKey: "eScooterSharing" },
  link: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, titleKey: "eScooterSharing" },
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
  "osm-parking": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "ndw-truck-nl": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "autobahn-de": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  "opendatahub-it": { icon: <LocalParkingIcon sx={{ fontSize: 20 }} />, titleKey: "parking" },
  // DB Station (RIS::Stations)
  "db-station": { icon: <TrainIcon sx={{ fontSize: 20 }} />, titleKey: "dbStation" },
  // Webcam
  webcam: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  windy: { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
  "osm-webcam": { icon: <VideocamIcon sx={{ fontSize: 20 }} />, titleKey: "webcams" },
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

function resolveSourceHeader(detail: DataSourceDetail): {
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

  // Fallback: capitalize source name
  return {
    icon: <InfoIcon sx={{ fontSize: 20 }} />,
    titleKey: null,
    titleFallback: primarySource.charAt(0).toUpperCase() + primarySource.slice(1),
  };
}

/** Map section icon identifier to the corresponding MUI icon element. */
function getSectionIcon(sectionIcon?: string): React.ReactNode {
  switch (sectionIcon) {
    case "fuel":
      return <LocalGasStationIcon />;
    case "access_time":
      return <AccessTimeIcon />;
    case "info":
      return <InfoIcon />;
    case "directions_bus":
      return <DirectionsBusIcon />;
    case "directions_car":
      return <DirectionsCarIcon />;
    case "payments":
      return <PaymentsIcon />;
    case "eco":
      return <EnergySavingsLeafIcon />;
    case "open_in_new":
      return <OpenInNewIcon />;
    case "videocam":
      return <VideocamIcon sx={{ fontSize: 18 }} />;
    case "warning":
      return <WarningAmberIcon sx={{ fontSize: 18 }} />;
    default:
      return <BoltIcon />;
  }
}

interface Props {
  detail: DataSourceDetail;
}

/** Render a single connector row in the compact list style. */
function ConnectorRow({ row }: { row: (string | number)[] }) {
  // row: [Type, Power, Current, Qty, Status]
  const [type, power, current, qty, status] = row;
  const statusStr = String(status ?? "");
  const isAvailable =
    statusStr.toLowerCase().includes("operational") ||
    statusStr.toLowerCase().includes("available");

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        py: 0.75,
        "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      <Box sx={{ minWidth: 0, flex: 1 }}>
        <Typography variant="body2" noWrap>
          {type}
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {power}
          {current ? ` · ${current}` : ""}
          {qty && Number(qty) > 1 ? ` · ${qty}x` : ""}
        </Typography>
      </Box>
      <Typography
        variant="caption"
        sx={{
          color: isAvailable ? "success.main" : "text.disabled",
          fontWeight: 500,
          flexShrink: 0,
          ml: 1,
        }}
      >
        {statusStr}
      </Typography>
    </Box>
  );
}

/** Matches a 3-decimal Euro price like "2.119 €". */
const EURO_PRICE_RE = /^(\d+\.\d{2})(\d)\s*€$/;

/** Renders a Euro price with the last digit in superscript, or plain text otherwise. */
function FormattedValue({ value }: { value: string | number }) {
  const str = String(value);
  const match = str.match(EURO_PRICE_RE);
  if (match) {
    return (
      <span style={{ display: "inline-flex", alignItems: "flex-start" }}>
        <span>{match[1]}</span>
        <span style={{ fontSize: "0.65em", marginTop: "0.15em" }}>{match[2]}</span>
        <span>&nbsp;€</span>
      </span>
    );
  }
  return <>{value}</>;
}

/** Check if a string looks like a URL. */
function isUrl(str: string): boolean {
  return /^https?:\/\//.test(str) || /^[a-z][\w-]*:\/\//.test(str);
}

/** Simple key-value row: label on the left, value on the right. */
function KeyValueRow({ row }: { row: (string | number)[] }) {
  const t = useTranslations("dataSources");
  const [label, value] = row;
  const labelStr = String(label);
  const labelKey = ROW_LABEL_KEYS[labelStr];
  const valueStr = String(value);
  const valueKey = ROW_LABEL_KEYS[valueStr];
  const isLink = typeof value === "string" && isUrl(value);
  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        py: 0.5,
        "&:not(:last-child)": { borderBottom: 1, borderColor: "divider" },
      }}
    >
      <Typography variant="body2" color="text.secondary" sx={{ flexShrink: 0 }}>
        {labelKey ? t(labelKey) : label}
      </Typography>
      {isLink ? (
        <Link
          href={valueStr}
          target="_blank"
          rel="noopener noreferrer"
          underline="hover"
          variant="body2"
          sx={{
            ml: 1,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {valueStr.replace(/^https?:\/\//, "").split("?")[0]}
        </Link>
      ) : (
        <Typography
          variant="body2"
          fontWeight={500}
          sx={{ ml: 1, minWidth: 0, textAlign: "right" }}
        >
          <FormattedValue value={valueKey ? t(valueKey) : value} />
        </Typography>
      )}
    </Box>
  );
}

function SectionContent({ section }: { section: DataSourceDetailSection }) {
  switch (section.type) {
    case "table": {
      if (!section.rows || section.rows.length === 0) return null;
      // 2-column tables render as compact key-value pairs
      const isKeyValue = section.rows.every((r) => r.length === 2);
      if (isKeyValue) {
        return (
          <Box>
            {section.rows.map((row, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
              <KeyValueRow key={i} row={row} />
            ))}
          </Box>
        );
      }
      return (
        <Box>
          {section.rows.map((row, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows have no stable id
            <ConnectorRow key={i} row={row} />
          ))}
        </Box>
      );
    }

    case "list": {
      if (!section.items) return null;
      return (
        <Box component="ul" sx={{ pl: 2.5, my: 0.5 }}>
          {section.items.map((item) => (
            <Box component="li" key={item} sx={{ fontSize: 13, mb: 0.25 }}>
              {item}
            </Box>
          ))}
        </Box>
      );
    }

    case "text": {
      if (!section.content) return null;
      return (
        <Typography variant="body2" sx={{ mb: 1 }}>
          {section.content}
        </Typography>
      );
    }

    case "image": {
      if (!section.imageUrl) return null;
      const img = (
        <Box
          component="img"
          src={section.imageUrl}
          alt={section.imageAlt ?? section.title}
          sx={{ width: "100%", borderRadius: 2, display: "block" }}
        />
      );
      return section.linkUrl ? (
        <Link
          href={section.linkUrl}
          target="_blank"
          rel="noopener noreferrer"
          sx={{ display: "block", mb: 1 }}
        >
          {img}
        </Link>
      ) : (
        <Box sx={{ mb: 1 }}>{img}</Box>
      );
    }

    case "embed": {
      if (!section.embedUrl) return null;
      if (section.embedType === "video") {
        return (
          <Box sx={{ mb: 1 }}>
            <HlsVideo
              src={section.embedUrl}
              controls
              autoPlay
              muted
              style={{ width: "100%", borderRadius: 8, display: "block" }}
            />
          </Box>
        );
      }
      return (
        <Box sx={{ mb: 1 }}>
          <Box
            component="iframe"
            src={section.embedUrl}
            sandbox="allow-scripts allow-same-origin"
            sx={{
              width: "100%",
              aspectRatio: "16/9",
              border: "none",
              borderRadius: 2,
              display: "block",
            }}
          />
        </Box>
      );
    }

    default:
      return null;
  }
}

/** Map API section titles to i18n keys. */
const SECTION_TITLE_KEYS: Record<string, string> = {
  Availability: "sectionAvailability",
  "Public Transit": "sectionPublicTransit",
  "Vehicle Details": "sectionVehicleDetails",
  "Vehicle Classes": "sectionVehicleClasses",
  Pricing: "sectionPricing",
  Book: "sectionBook",
  Directions: "sectionDirections",
  Notes: "sectionNotes",
  Connectors: "sectionConnectors",
  Usage: "sectionUsage",
  Access: "sectionAccess",
  Facility: "sectionFacility",
  Fee: "sectionFee",
  Payment: "sectionPayment",
};

/** Map API row labels (left column of key-value tables) to i18n keys. */
const ROW_LABEL_KEYS: Record<string, string> = {
  "Available Vehicles": "rowAvailableVehicles",
  "Empty Slots": "rowEmptySlots",
  "Total Capacity": "rowTotalCapacity",
  Type: "rowType",
  Pricing: "rowPricing",
  Vehicle: "rowVehicle",
  Propulsion: "rowPropulsion",
  Seats: "rowSeats",
  Features: "rowFeatures",
  "CO₂": "rowCo2",
  "Bus Lines": "rowBusLines",
  "Nearest Stops": "rowNearestStops",
  "Fixed Station": "fixedStation",
  "Free-floating Zone": "freeFloatingZone",
  "Zero emissions": "zeroEmissions",
  "Free Spaces": "rowFreeSpaces",
  Occupancy: "rowOccupancy",
  "Max Height": "rowMaxHeight",
  "Disabled Spaces": "rowDisabledSpaces",
  "EV Charging": "rowEvCharging",
  "Park & Ride": "rowParkAndRide",
  Capacity: "rowCapacity",
  Status: "rowStatus",
  Access: "rowAccess",
  "Nearest Station": "rowNearestStation",
  // Parking type values
  "Parking Garage": "parkingGarage",
  "Underground Garage": "undergroundGarage",
  "Surface Lot": "surfaceLot",
  "On-Street": "onStreet",
  // Fee values
  "Free Parking": "freeParking",
  "Paid Parking": "paidParking",
  Unknown: "unknownFee",
  // Parking tariff durations
  "20 min": "dur20min",
  "30 min": "dur30min",
  "1h": "dur1h",
  "1 day": "dur1day",
  "1 day (P-Card)": "dur1dayPCard",
  "1 week": "dur1week",
  "1 week (P-Card)": "dur1weekPCard",
  "1 month": "dur1month",
  "1 month (long-term)": "dur1monthLong",
  "1 month (reserved)": "dur1monthReserved",
  // Webcam row labels
  City: "rowCity",
  Region: "rowRegion",
  Country: "rowCountry",
  Categories: "rowCategories",
  Views: "rowViews",
  "Last Updated": "rowLastUpdated",
  Direction: "rowDirection",
  Nearby: "rowNearby",
  County: "rowCounty",
  "Live Stream": "rowLiveStream",
  View: "rowView",
  Park: "rowPark",
  State: "rowState",
  Tags: "rowTags",
  "NPS Page": "rowNpsPage",
  Road: "rowRoad",
  Location: "rowLocation",
  // Common values
  Yes: "yes",
  Open: "open",
  Closed: "closed",
  Customers: "customers",
  Private: "private",
  Permit: "permit",
};

function SectionWrapper({ section }: { section: DataSourceDetailSection }) {
  const t = useTranslations("dataSources");
  const [expanded, setExpanded] = useState(!section.collapsed);
  const titleKey = SECTION_TITLE_KEYS[section.title];
  const translatedTitle = titleKey ? t(titleKey) : section.title;

  return (
    <Box sx={{ px: 2, py: 1.25 }}>
      <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
        <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: 0.25 }}>
          {getSectionIcon(section.sectionIcon)}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box
            sx={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              mb: expanded ? 0.5 : 0,
              ...(section.collapsed ? { cursor: "pointer" } : {}),
            }}
            onClick={section.collapsed ? () => setExpanded((v) => !v) : undefined}
          >
            <Typography variant="body2" fontWeight={600}>
              {translatedTitle}
            </Typography>
            {section.collapsed && (
              <IconButton size="small" sx={{ ml: 0.5, p: 0 }}>
                <ExpandMoreIcon
                  sx={{
                    fontSize: 18,
                    transform: expanded ? "rotate(180deg)" : "none",
                    transition: "transform 0.2s",
                  }}
                />
              </IconButton>
            )}
          </Box>
          {section.collapsed ? (
            <Collapse in={expanded}>
              <SectionContent section={section} />
            </Collapse>
          ) : (
            <SectionContent section={section} />
          )}
        </Box>
      </Box>
    </Box>
  );
}

function AttributionFooter({ detail }: { detail: DataSourceDetail }) {
  const tc = useTranslations("common");
  const registry = useIntegrationRegistry();

  // Find the integration whose dataSources contain a matching sourceId.
  // This is independent of UI selection state so it works for both
  // data-source layer clicks and useDataSourceMatch (regular POI).
  const prefixes = new Set(detail.sources.map(extractSourcePrefix));
  const meta = registry
    .getByDomain("data-source")
    .find((m) => m.dataSources?.some((ds) => prefixes.has(ds.sourceId)));
  const html = meta?.dataSources ? buildSourceAttribution(meta.dataSources, detail.sources) : "";

  if (!html) return null;

  return (
    <Box sx={{ px: 2, py: 1.25 }}>
      <Typography
        variant="caption"
        color="text.secondary"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: attribution HTML from trusted integration manifests
        dangerouslySetInnerHTML={{ __html: `${tc("data")}: ${html}` }}
      />
    </Box>
  );
}

export function DataSourceSections({ detail }: Props) {
  const t = useTranslations("dataSources");
  const header = resolveSourceHeader(detail);

  return (
    <Box>
      <Divider sx={{ mx: 2, my: 1 }} />

      {/* Section header — like Transit section */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 2, pt: 1.5, pb: 0.5 }}>
        <Box sx={{ color: TEAL, display: "flex" }}>{header.icon}</Box>
        <Typography variant="subtitle2" fontWeight={600} color="text.primary">
          {header.titleKey ? t(header.titleKey) : header.titleFallback}
        </Typography>
      </Box>

      {/* Operator */}
      {detail.operator && (
        <Box sx={{ display: "flex", gap: 2, alignItems: "center", py: 1.25, px: 2 }}>
          <Box sx={{ color: TEAL, flexShrink: 0, display: "flex" }}>
            <BusinessIcon />
          </Box>
          <Box sx={{ flex: 1, minWidth: 0 }}>
            {detail.operator.url ? (
              <Link
                href={detail.operator.url}
                target="_blank"
                rel="noopener noreferrer"
                underline="hover"
                variant="body2"
                color="text.primary"
              >
                {detail.operator.name}
              </Link>
            ) : (
              <Typography variant="body2">{detail.operator.name}</Typography>
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
            <Typography variant="body2">{detail.usageInfo.type}</Typography>
            {detail.usageInfo.cost && (
              <Typography variant="caption" color="text.secondary">
                {detail.usageInfo.cost}
              </Typography>
            )}
            {detail.usageInfo.membershipRequired && (
              <Typography variant="caption" color="text.secondary" display="block">
                {t("membershipRequiredLabel")}
              </Typography>
            )}
          </Box>
        </Box>
      )}

      {/* Dynamic sections (connectors, etc.) */}
      {detail.sections.length > 0 &&
        detail.sections.map((section) => <SectionWrapper key={section.title} section={section} />)}

      {/* Attribution footer */}
      <Divider sx={{ mx: 2 }} />
      <AttributionFooter detail={detail} />
    </Box>
  );
}
