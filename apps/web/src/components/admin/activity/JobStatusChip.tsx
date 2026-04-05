"use client";

import Chip from "@mui/material/Chip";

const STATUS_COLOR: Record<string, "default" | "primary" | "success" | "error" | "warning"> = {
  queued: "default",
  running: "primary",
  success: "success",
  failed: "error",
  canceled: "warning",
};

export function JobStatusChip({ status }: { status: string }) {
  return (
    <Chip
      label={status}
      size="small"
      color={STATUS_COLOR[status] ?? "default"}
      variant={status === "running" ? "filled" : "outlined"}
    />
  );
}
