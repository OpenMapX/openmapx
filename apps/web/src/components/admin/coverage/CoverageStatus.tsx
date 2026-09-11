"use client";

import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlineOutlined";
import ErrorOutlineIcon from "@mui/icons-material/ErrorOutlineOutlined";
import HelpOutlineIcon from "@mui/icons-material/HelpOutlineOutlined";
import InfoOutlinedIcon from "@mui/icons-material/InfoOutlined";
import WarningAmberIcon from "@mui/icons-material/WarningAmber";
import Chip from "@mui/material/Chip";
import Stack from "@mui/material/Stack";
import Tooltip from "@mui/material/Tooltip";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";

export type CoverageStatusValue =
  | "operational"
  | "limited"
  | "unavailable"
  | "unknown"
  | "current"
  | "stale"
  | "expired"
  | "not-applicable"
  | "up"
  | "degraded"
  | "down"
  | "unconfigured"
  | "present"
  | "empty"
  | "not-configured"
  | "exact"
  | "contains"
  | "intersects"
  | "disjoint"
  | "permitted"
  | "conditions-apply"
  | "not-permitted"
  | "review-required"
  | "running"
  | "succeeded"
  | "unchanged"
  | "partial"
  | "failed"
  | "skipped";

const COLOR_BY_STATUS: Record<
  CoverageStatusValue,
  "success" | "warning" | "error" | "default" | "info"
> = {
  operational: "success",
  current: "success",
  up: "success",
  permitted: "success",
  present: "success",
  limited: "warning",
  stale: "warning",
  degraded: "warning",
  "conditions-apply": "warning",
  empty: "info",
  unavailable: "error",
  expired: "error",
  down: "error",
  "not-permitted": "error",
  unknown: "default",
  "not-applicable": "default",
  unconfigured: "default",
  "not-configured": "default",
  "review-required": "warning",
  exact: "success",
  contains: "success",
  intersects: "warning",
  disjoint: "error",
  running: "info",
  succeeded: "success",
  unchanged: "info",
  partial: "warning",
  failed: "error",
  skipped: "info",
};

function Icon({ status }: { status: CoverageStatusValue }): ReactNode {
  if (
    [
      "operational",
      "current",
      "up",
      "permitted",
      "present",
      "exact",
      "contains",
      "succeeded",
    ].includes(status)
  ) {
    return <CheckCircleOutlineIcon fontSize="small" aria-hidden="true" />;
  }
  if (["unavailable", "expired", "down", "not-permitted", "disjoint", "failed"].includes(status)) {
    return <ErrorOutlineIcon fontSize="small" aria-hidden="true" />;
  }
  if (
    [
      "limited",
      "stale",
      "degraded",
      "conditions-apply",
      "review-required",
      "intersects",
      "partial",
    ].includes(status)
  ) {
    return <WarningAmberIcon fontSize="small" aria-hidden="true" />;
  }
  if (status === "empty") return <InfoOutlinedIcon fontSize="small" aria-hidden="true" />;
  return <HelpOutlineIcon fontSize="small" aria-hidden="true" />;
}

export function CoverageStatus({
  status,
  label,
  reasons = [],
  size = "small",
}: {
  status: CoverageStatusValue;
  label?: string;
  reasons?: readonly string[];
  size?: "small" | "medium";
}) {
  const t = useTranslations("adminCoverage");
  const text = label ?? t(`status.${status}`);
  const chip = (
    <Chip
      icon={<Icon status={status} />}
      color={COLOR_BY_STATUS[status]}
      label={text}
      size={size}
      variant={status === "unknown" || status === "not-applicable" ? "outlined" : "filled"}
      sx={{
        maxWidth: "100%",
        "& .MuiChip-label": { overflow: "hidden", textOverflow: "ellipsis" },
      }}
    />
  );
  if (reasons.length === 0) return chip;
  return (
    <Tooltip title={reasons.map((reason) => t(`reason.${reason}`)).join(" · ")} arrow>
      <Stack component="span" sx={{ display: "inline-flex" }}>
        {chip}
      </Stack>
    </Tooltip>
  );
}

export function formatCoverageDate(value: string | null | undefined): string {
  if (!value) return "—";
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "—";
  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(timestamp));
}
