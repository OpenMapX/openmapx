"use client";

import Chip from "@mui/material/Chip";
import type { ServiceStatus } from "@/hooks/useServices";

export function statusColor(status: ServiceStatus): "success" | "warning" | "error" | "default" {
  if (status === "running") return "success";
  if (status === "restarting") return "warning";
  if (status === "exited") return "error";
  return "default";
}

export function statusLabel(status: ServiceStatus): string {
  if (status === "not-running") return "Not running";
  return status.charAt(0).toUpperCase() + status.slice(1);
}

export function ServiceStatusChip({ status }: { status: ServiceStatus }) {
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
