"use client";

import AccessTimeIcon from "@mui/icons-material/AccessTime";
import BoltIcon from "@mui/icons-material/Bolt";
import BusinessIcon from "@mui/icons-material/Business";
import DirectionsCarIcon from "@mui/icons-material/DirectionsCar";
import ElectricScooterIcon from "@mui/icons-material/ElectricScooter";
import EvStationIcon from "@mui/icons-material/EvStation";
import InfoIcon from "@mui/icons-material/Info";
import LocalGasStationIcon from "@mui/icons-material/LocalGasStation";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { DataSourceDetail, DataSourceDetailSection } from "@openmapx/core";
import type { ReactNode } from "react";
import { TEAL } from "@/lib/theme";

/** Section header config per data source type. */
const SOURCE_HEADERS: Record<string, { icon: ReactNode; title: string }> = {
  // EV Charging
  "ev-charging": { icon: <EvStationIcon sx={{ fontSize: 20 }} />, title: "EV Charging" },
  ocm: { icon: <EvStationIcon sx={{ fontSize: 20 }} />, title: "EV Charging" },
  osm: { icon: <EvStationIcon sx={{ fontSize: 20 }} />, title: "EV Charging" },
  // Fuel
  fuel: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, title: "Fuel Prices" },
  tankerkoenig: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, title: "Fuel Prices" },
  france: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, title: "Fuel Prices" },
  spain: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, title: "Fuel Prices" },
  austria: { icon: <LocalGasStationIcon sx={{ fontSize: 20 }} />, title: "Fuel Prices" },
  // Bike Sharing
  "bike-sharing": { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, title: "Bike Sharing" },
  nextbike: { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, title: "Bike Sharing" },
  citybikes: { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, title: "Bike Sharing" },
  donkey: { icon: <PedalBikeIcon sx={{ fontSize: 20 }} />, title: "Bike Sharing" },
  // Scooter Sharing
  "scooter-sharing": {
    icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />,
    title: "E-Scooter Sharing",
  },
  felyx: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, title: "E-Scooter Sharing" },
  gosharing: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, title: "E-Scooter Sharing" },
  link: { icon: <ElectricScooterIcon sx={{ fontSize: 20 }} />, title: "E-Scooter Sharing" },
  // Car Sharing
  "car-sharing": { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, title: "Car Sharing" },
  cambio: { icon: <DirectionsCarIcon sx={{ fontSize: 20 }} />, title: "Car Sharing" },
  // GBFS can be any type — will be resolved by prefix
  gbfs: { icon: <InfoIcon sx={{ fontSize: 20 }} />, title: "Shared Mobility" },
};

function resolveSourceHeader(detail: DataSourceDetail): { icon: ReactNode; title: string } {
  // Try exact source match first
  const exactMatch = SOURCE_HEADERS[detail.source];
  if (exactMatch) return exactMatch;

  // Try prefix (e.g., "tankerkoenig" from "tankerkoenig/uuid", "nextbike" from "nextbike/362/1234")
  const prefix = detail.source.split("/")[0];
  const prefixMatch = SOURCE_HEADERS[prefix];
  if (prefixMatch) return prefixMatch;

  // Fallback: capitalize source name
  return {
    icon: <InfoIcon sx={{ fontSize: 20 }} />,
    title: detail.source.charAt(0).toUpperCase() + detail.source.slice(1),
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

/** Simple key-value row: label on the left, value on the right. */
function KeyValueRow({ row }: { row: (string | number)[] }) {
  const [label, value] = row;
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
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <Typography variant="body2" fontWeight={500} sx={{ ml: 1, flexShrink: 0 }}>
        <FormattedValue value={value} />
      </Typography>
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

    default:
      return null;
  }
}

export function DataSourceSections({ detail }: Props) {
  const header = resolveSourceHeader(detail);

  return (
    <Box>
      <Divider />

      {/* Section header — like Transit section */}
      <Box sx={{ display: "flex", alignItems: "center", gap: 0.75, px: 2, pt: 1.5, pb: 0.5 }}>
        <Box sx={{ color: TEAL, display: "flex" }}>{header.icon}</Box>
        <Typography variant="subtitle2" fontWeight={600} color="text.primary">
          {header.title}
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
                Membership required
              </Typography>
            )}
          </Box>
        </Box>
      )}

      {/* Dynamic sections (connectors, etc.) */}
      {detail.sections.length > 0 &&
        detail.sections.map((section) => (
          <Box key={section.title} sx={{ px: 2, py: 1.25 }}>
            <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
              <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: 0.25 }}>
                {getSectionIcon(section.sectionIcon)}
              </Box>
              <Box sx={{ flex: 1, minWidth: 0 }}>
                <Typography variant="body2" fontWeight={600} sx={{ mb: 0.5 }}>
                  {section.title}
                </Typography>
                <SectionContent section={section} />
              </Box>
            </Box>
          </Box>
        ))}

      {/* Attribution footer */}
      <Divider />
      <Box sx={{ px: 2, py: 1.25 }}>
        <Typography variant="caption" color="text.secondary">
          Data:{" "}
          <Link
            href={detail.attribution.url}
            target="_blank"
            rel="noopener noreferrer"
            underline="hover"
            color="text.secondary"
          >
            {detail.attribution.text}
          </Link>
          {detail.attribution.license &&
            (detail.attribution.licenseUrl ? (
              <>
                {" ("}
                <Link
                  href={detail.attribution.licenseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  underline="hover"
                  color="text.secondary"
                >
                  {detail.attribution.license}
                </Link>
                {")"}
              </>
            ) : (
              ` (${detail.attribution.license})`
            ))}
        </Typography>
      </Box>
    </Box>
  );
}
