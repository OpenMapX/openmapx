"use client";

import Typography from "@mui/material/Typography";
import type { RoadConditionRouteImpact, Route } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { TrafficInfo } from "@/integration-api/components/TrafficInfo";
import { type RoutingEngineLabels, routeTrafficStatus } from "@/lib/route-traffic-status";
import { useRouteTrafficPresentation } from "@/lib/useRouteTrafficPresentation";
import { useRoutingEngineCatalog } from "@/lib/useRoutingEngines";

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
  const { engines, state: catalog } = useRoutingEngineCatalog();
  const labels = useMemo<RoutingEngineLabels>(
    () =>
      Object.fromEntries(engines.map(({ id, name, trafficProof }) => [id, { name, trafficProof }])),
    [engines],
  );
  const status = routeTrafficStatus(route, impact, provider, labels, Date.now());
  // Without the capabilities the engine is unknown: name it by its raw id, or
  // call a provable route unverified, and the note would be wrong. The
  // server's own assessment (expired, limited, unavailable) still holds.
  const enginesKnown = catalog === "ready";
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
      {traffic.kind === "unavailable" && (
        <Typography variant="body2" sx={{ fontWeight: 600, mb: 1 }}>
          {t("summary")}
        </Typography>
      )}
      <Typography variant="body2" sx={{ mb: 1 }}>
        {t(
          traffic.kind === "delay"
            ? "estimateExplanation"
            : traffic.kind === "clear"
              ? "coverageExplanation"
              : "congestionUnverified",
        )}
      </Typography>
      {enginesKnown || status.application !== "unverified" ? (
        <Typography variant="body2" sx={{ mb: 1 }}>
          {t(`application.${status.application}`)}
        </Typography>
      ) : catalog === "loading" ? (
        <Typography variant="body2" sx={{ mb: 1, color: "text.secondary" }}>
          {t("application.checking")}
        </Typography>
      ) : null}
      {enginesKnown && (
        <Typography variant="caption" sx={{ color: "text.secondary" }}>
          {t("provider", {
            source: !status.source
              ? t("sourceUnknown")
              : status.source.hosted
                ? t("sourceHosted", { name: status.source.name })
                : status.source.name,
          })}
        </Typography>
      )}
    </TrafficInfo>
  );
}
