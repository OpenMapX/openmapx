"use client";

import Chip, { type ChipProps } from "@mui/material/Chip";
import Tooltip from "@mui/material/Tooltip";
import type { ReactNode } from "react";
import { useAdminTranslations } from "@/lib/admin/adminTranslator";
import { jobStatusColor, jobStatusDescription } from "./jobStatus";

export function JobStatusChip({
  status,
  label,
  variant,
  sx,
  stage = false,
}: {
  status: string | null;
  label?: ReactNode;
  variant?: ChipProps["variant"];
  sx?: ChipProps["sx"];
  /** The status is a transit stage's, not a job's. */
  stage?: boolean;
}) {
  const t = useAdminTranslations("adminShared");
  const value = status ?? "never";
  const chip = (
    <Chip
      label={label ?? t("jobStatusLabel", { status: value })}
      size="small"
      color={jobStatusColor(value)}
      variant={variant ?? (value === "running" ? "filled" : "outlined")}
      sx={sx}
    />
  );
  const description = jobStatusDescription(value, t, stage);
  return description ? <Tooltip title={description}>{chip}</Tooltip> : chip;
}
