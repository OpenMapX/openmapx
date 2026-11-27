"use client";

import Box from "@mui/material/Box";
import Tooltip from "@mui/material/Tooltip";
import type { AdminIntegrationSummary } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";

type IntegrationStatus = AdminIntegrationSummary["status"];

const STATUS_COLOR: Record<IntegrationStatus, string> = {
  healthy: "#22c55e",
  unhealthy: "#ef4444",
  failed: "#ef4444",
  unconfigured: "#f59e0b",
  disabled: "#9ca3af",
};

/** Whether a status belongs under "unhealthy" in counts and filters. */
export function isUnhealthyStatus(status: IntegrationStatus): boolean {
  return status === "unhealthy" || status === "failed";
}

/** The status the API derives for an integration, as a coloured dot with a label. */
export function IntegrationStatusDot({
  status,
  size = 10,
}: {
  status: IntegrationStatus;
  size?: number;
}) {
  const t = useTranslations("adminIntegrations");
  const labels: Record<IntegrationStatus, string> = {
    healthy: t("statusHealthy"),
    unhealthy: t("statusUnhealthy"),
    failed: t("statusFailed"),
    unconfigured: t("statusUnconfigured"),
    disabled: t("statusDisabled"),
  };
  const label = labels[status];

  return (
    <Tooltip title={label} arrow placement="top">
      <Box
        role="img"
        aria-label={label}
        sx={{
          width: size,
          height: size,
          borderRadius: "50%",
          bgcolor: STATUS_COLOR[status],
          flexShrink: 0,
          display: "inline-block",
        }}
      />
    </Tooltip>
  );
}
