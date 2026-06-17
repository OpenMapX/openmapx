"use client";

import Chip from "@mui/material/Chip";
import { jobStatusColor } from "../shared/jobStatus";

export function JobStatusChip({ status }: { status: string }) {
  return (
    <Chip
      label={status}
      size="small"
      color={jobStatusColor(status)}
      variant={status === "running" ? "filled" : "outlined"}
    />
  );
}
