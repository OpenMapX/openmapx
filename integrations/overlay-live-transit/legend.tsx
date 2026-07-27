"use client";

import Box from "@mui/material/Box";
import Chip from "@mui/material/Chip";
import Typography from "@mui/material/Typography";
import { relativeTime } from "@openmapx/core";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import type { TransportMode } from "@openmapx/mobility-core/transit";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { OverlayLegend } from "@/components/map/OverlayLegend";
import { modeColor } from "@/lib/transitMarkers";
import { useLiveTransitStore } from "./store";

const MODE_LABEL_KEYS: Partial<Record<TransportMode, string>> = {
  rail: "trains",
  subway: "subway",
  tram: "trams",
  bus: "buses",
  ferry: "ferries",
  gondola: "gondola",
  funicular: "funicular",
  cable_car: "cableCar",
  monorail: "monorail",
};

function providerLabel(
  registry: ReturnType<typeof useIntegrationRegistry>,
  sourceId: string,
): string {
  const integration = registry
    .getByDomain("live-transit")
    .find((candidate) => candidate.dataSources?.some((source) => source.sourceId === sourceId));
  if (integration?.name) {
    return integration.name.replace(/\s+Live Transit$/i, "");
  }
  return registry.findDataSource(sourceId)?.name ?? sourceId;
}

export function LiveTransitLegend() {
  const t = useTranslations("liveTransit");
  const transitT = useTranslations("transit");
  const registry = useIntegrationRegistry();
  const panelOpen = useLiveTransitStore((s) => s.panelOpen);
  const layerVisible = useLiveTransitStore((s) => s.layerVisible);
  const setLayerVisible = useLiveTransitStore((s) => s.setLayerVisible);
  const loading = useLiveTransitStore((s) => s.loading);
  const totalVehicleCount = useLiveTransitStore((s) => s.totalVehicleCount);
  const visibleVehicleCount = useLiveTransitStore((s) => s.visibleVehicleCount);
  const lastUpdated = useLiveTransitStore((s) => s.lastUpdated);
  const availableProviders = useLiveTransitStore((s) => s.availableProviders);
  const availableModes = useLiveTransitStore((s) => s.availableModes);
  const availableCodespaces = useLiveTransitStore((s) => s.availableCodespaces);
  const excludedProviders = useLiveTransitStore((s) => s.excludedProviders);
  const excludedModes = useLiveTransitStore((s) => s.excludedModes);
  const excludedCodespaces = useLiveTransitStore((s) => s.excludedCodespaces);
  const toggleProvider = useLiveTransitStore((s) => s.toggleProvider);
  const toggleMode = useLiveTransitStore((s) => s.toggleMode);
  const toggleCodespace = useLiveTransitStore((s) => s.toggleCodespace);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!panelOpen || !lastUpdated) return;
    setNow(Date.now());
    const timer = window.setInterval(() => {
      setNow(Date.now());
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [lastUpdated, panelOpen]);

  return (
    <OverlayLegend
      title={t("liveTransit")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={loading}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleOverlay")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 420 }, minWidth: 260 }}
      headerSx={{ mb: 0.5 }}
    >
      {availableProviders.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
            {t("providers")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {availableProviders.map((providerId) => {
              const active = !excludedProviders.has(providerId);
              return (
                <Chip
                  key={providerId}
                  label={providerLabel(registry, providerId)}
                  size="small"
                  variant={active ? "filled" : "outlined"}
                  onClick={() => toggleProvider(providerId)}
                  sx={{ fontSize: 11, height: 24 }}
                />
              );
            })}
          </Box>
        </Box>
      )}

      {availableModes.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
            {t("modes")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {availableModes.map((mode) => {
              const active = !excludedModes.has(mode);
              const color = modeColor(mode);
              const labelKey = MODE_LABEL_KEYS[mode];
              return (
                <Chip
                  key={mode}
                  label={labelKey ? transitT(labelKey) : mode}
                  size="small"
                  variant={active ? "filled" : "outlined"}
                  onClick={() => toggleMode(mode)}
                  sx={{
                    fontSize: 11,
                    height: 24,
                    ...(active
                      ? {
                          bgcolor: color,
                          color: "#fff",
                          "&:hover": { bgcolor: color, opacity: 0.9 },
                        }
                      : {
                          borderColor: color,
                          color,
                        }),
                  }}
                />
              );
            })}
          </Box>
        </Box>
      )}

      {availableCodespaces.length > 0 && (
        <Box sx={{ mb: 1 }}>
          <Typography sx={{ fontSize: 11, color: "text.secondary", mb: 0.5 }}>
            {t("codespaces")}
          </Typography>
          <Box sx={{ display: "flex", gap: 0.5, flexWrap: "wrap" }}>
            {availableCodespaces.map((codespaceId) => {
              const active = !excludedCodespaces.has(codespaceId);
              return (
                <Chip
                  key={codespaceId}
                  label={codespaceId}
                  size="small"
                  variant={active ? "filled" : "outlined"}
                  onClick={() => toggleCodespace(codespaceId)}
                  sx={{ fontSize: 11, height: 24 }}
                />
              );
            })}
          </Box>
        </Box>
      )}

      <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
        {totalVehicleCount > 0
          ? visibleVehicleCount === totalVehicleCount
            ? t("vehiclesShowing", { count: visibleVehicleCount })
            : t("vehiclesFiltered", {
                visible: visibleVehicleCount,
                total: totalVehicleCount,
              })
          : loading
            ? t("loading")
            : t("noVehicles")}
      </Typography>

      {lastUpdated && (
        <Typography sx={{ fontSize: 10.5, color: "text.secondary", mt: 0.25 }}>
          {t("lastUpdated", { time: relativeTime(now - lastUpdated) })}
        </Typography>
      )}
    </OverlayLegend>
  );
}
