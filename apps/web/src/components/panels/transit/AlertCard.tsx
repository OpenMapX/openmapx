"use client";

import ErrorOutlineIcon from "@mui/icons-material/ErrorOutline";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import ReportProblemOutlinedIcon from "@mui/icons-material/ReportProblemOutlined";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { AlertSeverity, ServiceAlert } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useState } from "react";

const SEVERITY_CONFIG: Record<
  AlertSeverity,
  {
    icon: typeof InfoOutlinedIcon;
    bg: string;
    border: string;
    color: string;
    labelKey: string;
  }
> = {
  info: {
    icon: InfoOutlinedIcon,
    bg: "var(--mui-palette-info-light, #E8F4FD)",
    border: "var(--mui-palette-info-main, #90CAF9)",
    color: "var(--mui-palette-info-dark, #1565C0)",
    labelKey: "alertInfo",
  },
  warning: {
    icon: ReportProblemOutlinedIcon,
    bg: "var(--mui-palette-warning-light, #FFF8E1)",
    border: "var(--mui-palette-warning-main, #FFE082)",
    color: "var(--mui-palette-warning-dark, #E65100)",
    labelKey: "alertWarning",
  },
  severe: {
    icon: ErrorOutlineIcon,
    bg: "var(--mui-palette-error-light, #FBE9E7)",
    border: "var(--mui-palette-error-main, #FFAB91)",
    color: "var(--mui-palette-error-dark, #BF360C)",
    labelKey: "alertSevere",
  },
  critical: {
    icon: ErrorOutlineIcon,
    bg: "var(--mui-palette-error-light, #FFEBEE)",
    border: "var(--mui-palette-error-main, #EF9A9A)",
    color: "var(--mui-palette-error-dark, #B71C1C)",
    labelKey: "alertCritical",
  },
};

export { SEVERITY_CONFIG };

export const SEVERITY_PRIORITY: Record<AlertSeverity, number> = {
  critical: 4,
  severe: 3,
  warning: 2,
  info: 1,
};

interface AlertCardProps {
  alert: ServiceAlert;
  /** Compact mode: smaller text, no description, no attribution. Used in leg alerts. */
  compact?: boolean;
  /** Whether the description is expandable (default true). */
  expandable?: boolean;
}

export function AlertCard({ alert, compact = false, expandable = true }: AlertCardProps) {
  const _t = useTranslations("transit");
  const [descExpanded, setDescExpanded] = useState(false);
  const config = SEVERITY_CONFIG[alert.severity];
  const Icon = config.icon;

  return (
    <Box
      sx={{
        display: "flex",
        alignItems: "flex-start",
        gap: compact ? 0.75 : 1,
        p: compact ? 0.75 : 1.25,
        bgcolor: config.bg,
        borderLeft: `3px solid ${config.border}`,
        borderRadius: "0 6px 6px 0",
      }}
    >
      <Icon
        sx={{
          color: config.color,
          fontSize: compact ? 16 : 18,
          mt: compact ? 0.1 : 0.15,
          flexShrink: 0,
        }}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography
          variant={compact ? "caption" : "body2"}
          fontWeight={600}
          sx={{ color: config.color, lineHeight: 1.4 }}
        >
          {alert.title}
        </Typography>
        {!compact && alert.description && (
          <Typography
            variant="caption"
            color="text.secondary"
            onClick={expandable ? () => setDescExpanded((e) => !e) : undefined}
            sx={{
              display: "block",
              mt: 0.25,
              lineHeight: 1.4,
              cursor: expandable ? "pointer" : "default",
              ...(!descExpanded &&
                expandable && {
                  display: "-webkit-box",
                  WebkitLineClamp: 2,
                  WebkitBoxOrient: "vertical",
                  overflow: "hidden",
                }),
            }}
          >
            {alert.description}
          </Typography>
        )}
      </Box>
    </Box>
  );
}
