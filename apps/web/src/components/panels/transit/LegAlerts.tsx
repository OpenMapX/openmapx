"use client";

import Box from "@mui/material/Box";
import Collapse from "@mui/material/Collapse";
import { useRouteAlerts } from "@openmapx/core";
import { contributorsForRecords } from "@openmapx/mobility-core/contributors";
import type { ServiceAlert } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useState } from "react";
import { AttributionStrip } from "@/components/ui/AttributionStrip";
import { ClickableRow } from "@/components/ui/ClickableRow";
import { AlertCard, SEVERITY_PRIORITY } from "./AlertCard";

interface LegAlertsProps {
  routeId?: string;
  /** Stop-specific alerts carried on the leg (board/alight/intermediate). */
  legAlerts?: ServiceAlert[];
}

export function LegAlerts({ routeId, legAlerts }: LegAlertsProps) {
  const t = useTranslations("transit");
  const [expanded, setExpanded] = useState(false);
  const { data: routeAlerts } = useRouteAlerts(routeId ?? null);

  // Merge the leg's inline stop alerts with the route-wide fetch, deduped by id
  // (the route feed doesn't carry board/alight-stop disruptions).
  const byId = new Map<string, ServiceAlert>();
  for (const a of legAlerts ?? []) byId.set(a.id, a);
  for (const a of routeAlerts ?? []) if (!byId.has(a.id)) byId.set(a.id, a);
  const merged = [...byId.values()];
  if (merged.length === 0) return null;

  const sorted = merged.sort(
    (a, b) => SEVERITY_PRIORITY[b.severity] - SEVERITY_PRIORITY[a.severity],
  );
  const hiddenCount = sorted.length - 1;

  return (
    <Box sx={{ mt: 0.75, mb: 0.25, display: "flex", flexDirection: "column", gap: 0.5 }}>
      <AlertCard alert={sorted[0]} compact />
      <AttributionStrip attributions={contributorsForRecords(sorted)} variant="inline" />
      {hiddenCount > 0 && (
        <>
          <ClickableRow
            aria-expanded={expanded}
            onClick={() => setExpanded((e) => !e)}
            sx={{
              width: "auto",
              alignSelf: "flex-start",
              typography: "caption",
              color: "text.secondary",
              fontSize: "0.65rem",
              pl: 0.75,
              "&:hover": { textDecoration: "underline" },
            }}
          >
            {expanded ? t("showLess") : t("showMoreAlerts", { count: hiddenCount })}
          </ClickableRow>
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
