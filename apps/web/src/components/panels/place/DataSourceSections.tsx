"use client";

import BoltIcon from "@mui/icons-material/Bolt";
import BusinessIcon from "@mui/icons-material/Business";
import LockOpenIcon from "@mui/icons-material/LockOpen";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import Link from "@mui/material/Link";
import Typography from "@mui/material/Typography";
import type { DataSourceDetail, DataSourceDetailSection } from "@openmapx/core";
import { TEAL } from "@/lib/theme";

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

function SectionContent({ section }: { section: DataSourceDetailSection }) {
  switch (section.type) {
    case "table": {
      if (!section.rows || section.rows.length === 0) return null;
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
  return (
    <Box>
      <Divider />

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
      {detail.sections.length > 0 && (
        <>
          <Divider />
          {detail.sections.map((section) => (
            <Box key={section.title} sx={{ px: 2, py: 1.25 }}>
              <Box sx={{ display: "flex", gap: 2, alignItems: "flex-start" }}>
                <Box sx={{ color: TEAL, flexShrink: 0, display: "flex", mt: 0.25 }}>
                  <BoltIcon />
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
        </>
      )}

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
          {detail.attribution.license && ` (${detail.attribution.license})`}
        </Typography>
      </Box>
    </Box>
  );
}
