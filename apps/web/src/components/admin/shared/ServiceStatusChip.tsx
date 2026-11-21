"use client";

import Chip from "@mui/material/Chip";
import type { AdminServiceStatus } from "@openmapx/core/api-contracts";
import { useTranslations } from "next-intl";

export function statusColor(
  status: AdminServiceStatus,
): "success" | "warning" | "error" | "default" {
  if (status === "running") return "success";
  if (status === "restarting") return "warning";
  if (status === "exited") return "error";
  return "default";
}

/** The reader-facing name of a container status. */
export function useServiceStatusLabel(): (status: AdminServiceStatus) => string {
  const t = useTranslations("adminShared");
  const labels: Record<AdminServiceStatus, string> = {
    running: t("serviceRunning"),
    exited: t("serviceExited"),
    restarting: t("serviceRestarting"),
    created: t("serviceCreated"),
    paused: t("servicePaused"),
    "not-running": t("serviceNotRunning"),
    unknown: t("serviceUnknown"),
  };
  return (status) => labels[status];
}

export function ServiceStatusChip({ status }: { status: AdminServiceStatus }) {
  const statusLabel = useServiceStatusLabel();
  return (
    <Chip
      label={statusLabel(status)}
      size="small"
      color={statusColor(status)}
      variant={status === "running" ? "filled" : "outlined"}
      sx={{ fontSize: "0.7rem" }}
    />
  );
}
