"use client";

import CancelOutlinedIcon from "@mui/icons-material/CancelOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { TripRemark } from "@openmapx/core";

const REMARK_CONFIG: Record<
  TripRemark["type"],
  { icon: typeof InfoOutlinedIcon; bg: string; border: string; color: string }
> = {
  info: {
    icon: InfoOutlinedIcon,
    bg: "#F5F5F5",
    border: "#BDBDBD",
    color: "#546e7a",
  },
  warning: {
    icon: ReportProblemOutlinedIcon,
    bg: "#FFF8E1",
    border: "#FFE082",
    color: "#E65100",
  },
  cancellation: {
    icon: CancelOutlinedIcon,
    bg: "#FFEBEE",
    border: "#EF9A9A",
    color: "#B71C1C",
  },
};

export const REMARK_PRIORITY: Record<TripRemark["type"], number> = {
  cancellation: 2,
  warning: 1,
  info: 0,
};

interface RemarkChipProps {
  remark: TripRemark;
  /** Inline mode: icon + text on a single line, no background. Used in departure list rows. */
  inline?: boolean;
}

export function RemarkChip({ remark, inline = false }: RemarkChipProps) {
  const config = REMARK_CONFIG[remark.type];
  const Icon = config.icon;

  if (inline) {
    return (
      <Box sx={{ display: "flex", alignItems: "flex-start", gap: 0.5 }}>
        <Icon sx={{ fontSize: 12, color: config.color, mt: "1px", flexShrink: 0 }} />
        <Typography
          variant="caption"
          sx={{ color: config.color, fontSize: "0.68rem", lineHeight: 1.4 }}
        >
          {remark.text}
        </Typography>
      </Box>
    );
  }

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: 0.75,
        px: 1,
        py: 0.5,
        bgcolor: config.bg,
        borderLeft: `3px solid ${config.border}`,
        borderRadius: "0 6px 6px 0",
      }}
    >
      <Icon sx={{ fontSize: 15, color: config.color, mt: 0.1, flexShrink: 0 }} />
      <Typography variant="caption" sx={{ color: config.color, lineHeight: 1.4 }}>
        {remark.text}
      </Typography>
    </Box>
  );
}
