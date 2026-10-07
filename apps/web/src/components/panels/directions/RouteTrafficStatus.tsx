"use client";

import Typography from "@mui/material/Typography";
import type { RoadConditionRouteImpact, Route } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TrafficInfo } from "@/integration-api/components/TrafficInfo";
import { routeTrafficStatus } from "@/lib/route-traffic-status";
import { useRouteTrafficPresentation } from "@/lib/useRouteTrafficPresentation";

export function RouteTrafficStatus({
  route,
  impact,
  provider,
}: {
  route: Route;
  impact?: RoadConditionRouteImpact;
  provider?: string;
}) {
  const t = useTranslations("trafficStatus");
  const [revision, setRevision] = useState(0);
  void revision;
  const status = routeTrafficStatus(route, impact, provider, Date.now());
  const deadline = status?.deadline;
  useEffect(() => {
    if (deadline == null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expire = () => {
      const remaining = deadline - Date.now();
      // A wall-clock correction can make a monotonic timeout fire early.
      if (remaining > 0) timer = setTimeout(expire, remaining);
      else setRevision((v) => v + 1);
    };
    expire();
    return () => clearTimeout(timer);
  }, [deadline]);
  const traffic = useRouteTrafficPresentation(route);
  if (!status) return null;
  return (
    <TrafficInfo>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {t(
          traffic.kind === "delay"
            ? "estimateExplanation"
            : traffic.kind === "clear"
              ? "coverageExplanation"
              : "congestionUnverified",
        )}
      </Typography>
      <Typography variant="body2" sx={{ mb: 1 }}>
        {t(`application.${status.application}`)}
      </Typography>
      <Typography variant="caption" color="text.secondary">
        {t("provider", { source: t(`source.${status.source}`) })}
      </Typography>
    </TrafficInfo>
  );
}
