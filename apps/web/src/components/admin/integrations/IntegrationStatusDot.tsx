"use client";

import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";

type StatusDotVariant = "healthy" | "unhealthy" | "unconfigured" | "disabled";

const STATUS_COLOR: Record<StatusDotVariant, string> = {
  healthy: "#22c55e",
  unhealthy: "#ef4444",
  unconfigured: "#f59e0b",
  disabled: "#9ca3af",
};

const STATUS_LABEL: Record<StatusDotVariant, string> = {
  healthy: "Healthy",
  unhealthy: "Unhealthy",
  unconfigured: "Unconfigured",
  disabled: "Disabled",
};

interface IntegrationStatusDotProps {
  enabled: boolean;
  configured: boolean;
  health: { status: "up" | "down" | "unconfigured" } | null;
  hasHealthCheck: boolean;
  size?: number;
}

export function computeStatusVariant(
  enabled: boolean,
  configured: boolean,
  health: { status: "up" | "down" | "unconfigured" } | null,
  hasHealthCheck: boolean,
): StatusDotVariant {
  if (!enabled) return "disabled";
  if (health?.status === "down") return "unhealthy";
  if (health?.status === "unconfigured" || !configured) return "unconfigured";
  if (hasHealthCheck && !health) return "unconfigured";
  return "healthy";
}

export function IntegrationStatusDot({
  enabled,
  configured,
  health,
  hasHealthCheck,
  size = 10,
}: IntegrationStatusDotProps) {
  const variant = computeStatusVariant(enabled, configured, health, hasHealthCheck);
  const color = STATUS_COLOR[variant];
  const label = STATUS_LABEL[variant];

  return (
    <Tooltip title={label} arrow placement="top">
      <Box
        sx={{
          width: size,
          height: size,
          borderRadius: "50%",
          bgcolor: color,
          flexShrink: 0,
          display: "inline-block",
        }}
      />
    </Tooltip>
  );
}
