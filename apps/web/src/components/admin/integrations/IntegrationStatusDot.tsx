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
  "safe-mode": "#3b82f6",
  incompatible: "#a855f7",
};

/** Whether a status belongs under "unhealthy" in counts and filters. */
export function isUnhealthyStatus(status: IntegrationStatus): boolean {
  return status === "unhealthy" || status === "failed";
}

/**
 * Whether the operator has the integration switched on. The API's `enabled`
 * is the run-time flag, which the host also clears for every integration it
 * does not run (failed, incompatible, in safe mode); only `disabled` means the
 * operator switched it, or its extension, off.
 */
export function isSwitchedOn(status: IntegrationStatus): boolean {
  return status !== "disabled";
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
    "safe-mode": t("statusSafeMode"),
    incompatible: t("statusIncompatible"),
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
