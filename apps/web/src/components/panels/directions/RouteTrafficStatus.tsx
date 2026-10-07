"use client";

import Box from "@mui/material/Box";
import Typography from "@mui/material/Typography";
import { formatDuration, type RoadConditionRouteImpact, type Route } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { TrafficInfo } from "@/integration-api/components/TrafficInfo";
import { TRAFFIC_TEXT_COLOR } from "@/integration-api/runtime/theme";
import { routeTrafficDelay } from "@/lib/route-traffic-delay";
import { routeTrafficStatus } from "@/lib/route-traffic-status";

export function RouteTrafficStatus({
  route,
  impact,
  provider,
  id,
}: {
  route: Route;
  impact?: RoadConditionRouteImpact;
  provider?: string;
  id?: string;
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
  if (!status) return null;
  const traffic = routeTrafficDelay(route);
  const caption = traffic?.band
    ? t("delay", { delay: formatDuration(traffic.seconds) })
    : !traffic
      ? t("summary")
      : null;
  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.25, mt: 0.25 }}>
      {caption && (
        <Typography
          id={id}
          component="div"
          variant="caption"
          data-testid={traffic?.band ? "traffic-delay" : "route-traffic-status"}
          sx={{
            color: traffic?.band ? TRAFFIC_TEXT_COLOR[traffic.band] : "text.secondary",
            overflowWrap: "anywhere",
          }}
        >
          {caption}
        </Typography>
      )}
      <TrafficInfo>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {t(traffic ? "estimateExplanation" : "congestionUnverified")}
        </Typography>
        <Typography variant="body2" sx={{ mb: 1 }}>
          {t(`application.${status.application}`)}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          {t("provider", { source: t(`source.${status.source}`) })}
        </Typography>
      </TrafficInfo>
    </Box>
  );
}
