"use client";

import Chip, { type ChipProps } from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import type { ReactNode } from "react";
import { jobStatusColor, jobStatusDescription } from "./jobStatus";

export function JobStatusChip({
  status,
  label,
  variant,
  sx,
}: {
  status: string | null;
  label?: ReactNode;
  variant?: ChipProps["variant"];
  sx?: ChipProps["sx"];
}) {
  const value = status ?? "never";
  const chip = (
    <Chip
      label={label ?? value}
      size="small"
      color={jobStatusColor(value)}
      variant={variant ?? (value === "running" ? "filled" : "outlined")}
      sx={sx}
    />
  );
  const description = jobStatusDescription(value);
  return description ? <Tooltip title={description}>{chip}</Tooltip> : chip;
}
