"use client";

import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import Typography from "@mui/material/Typography";
import { useRouteAlerts } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AlertCard, SEVERITY_PRIORITY } from "./AlertCard";

interface LegAlertsProps {
  routeId?: string;
}

export function LegAlerts({ routeId }: LegAlertsProps) {
  const t = useTranslations("transit");
  const [expanded, setExpanded] = useState(false);
  const { data: alerts } = useRouteAlerts(routeId ?? null);

  if (!routeId || !alerts || alerts.length === 0) return null;

  const sorted = [...alerts].sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  );
  const hiddenCount = sorted.length - 1;

  return (
    <Box sx={{ mt: 0.75, mb: 0.25, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <AlertCard alert={sorted[0]} compact />
      {hiddenCount > 0 && (
        <>
          <Typography
            variant="caption"
            color="text.secondary"
            onClick={() => setExpanded((e) => !e)}
            sx={{
              cursor: "pointer",
              fontSize: "0.65rem",
              pl: 0.75,
              "&:hover": { textDecoration: "underline" },
            }}
          >
            {expanded ? t("showLess") : t("showMoreAlerts", { count: hiddenCount })}
          </Typography>
          <Collapse in={expanded}>
            <Box sx={{ display: "flex", flexDirection: "column", gap: 0.5 }}>
              {sorted.slice(1).map((a) => (
                <AlertCard key={a.id} alert={a} compact />
              ))}
            </Box>
          </Collapse>
        </>
      )}
    </Box>
  );
}
