"use client";

import Typography from "@mui/material/Typography";
import type { RoadConditionRouteImpact, Route } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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
    const timer = setTimeout(() => setRevision((v) => v + 1), Math.max(0, deadline - Date.now()));
    return () => clearTimeout(timer);
  }, [deadline]);
  if (!status) return null;
  return (
    <Typography
      id={id}
      component="div"
      variant="caption"
      data-testid="route-traffic-status"
      sx={{ color: "text.secondary", display: "block", mt: 0.5, overflowWrap: "anywhere" }}
    >
      {t(`source.${status.source}`)}
      {" · "}
      {t(`application.${status.application}`)}
      <br />
      {t("congestionUnverified")}
    </Typography>
  );
}
