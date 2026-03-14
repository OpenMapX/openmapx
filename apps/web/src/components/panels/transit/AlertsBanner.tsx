"use client";

import ExpandLessIcon from "@mui/icons-material/ExpandLess";
import ExpandMoreIcon from "@mui/icons-material/ExpandMore";
import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import type { ServiceAlert } from "@openmapx/core";
import { useState } from "react";
import { AlertCard, SEVERITY_PRIORITY } from "./AlertCard";

interface AlertsBannerProps {
  alerts: ServiceAlert[];
}

export function AlertsBanner({ alerts }: AlertsBannerProps) {
  const [expanded, setExpanded] = useState(false);

  if (alerts.length === 0) return null;

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  );
  const visibleAlerts = expanded ? sorted : sorted.slice(0, 2);
  const hasMore = sorted.length > 2;

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 0.75, mb: 1 }}>
      {visibleAlerts.map((alert) => (
        <AlertCard key={alert.id} alert={alert} />
      ))}
      {hasMore && (
        <Box
          onClick={() => setExpanded(!expanded)}
          sx={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 0.5,
            py: 0.5,
            cursor: "pointer",
            borderRadius: 1,
            "&:hover": { bgcolor: "action.hover" },
          }}
        >
          {expanded ? (
            <ExpandLessIcon sx={{ fontSize: 16 }} />
          ) : (
            <ExpandMoreIcon sx={{ fontSize: 16 }} />
          )}
          <Typography variant="caption" color="text.secondary">
            {expanded
              ? "Show less"
              : `${sorted.length - 2} more alert${sorted.length - 2 !== 1 ? "s" : ""}`}
          </Typography>
        </Box>
      )}
    </Box>
  );
}
