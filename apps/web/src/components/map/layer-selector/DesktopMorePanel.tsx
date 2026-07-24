"use client";

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { MapLayer } from "@openmapx/core";
import { OVERLAY_REGISTRY, toggleOverlay, useCapabilities, useLayerStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { useOverlayZoomGate } from "@/lib/overlayZoomGate";
import { DesktopMoreTile } from "./DesktopMoreTile";
import { globePreview } from "./layerPreviewSvgs";
import { DESKTOP_MORE_MAP_TYPES } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

interface DesktopMorePanelProps {
  onClose: () => void;
}

function OverlayDetailTile({ item, label }: { item: GeneratedLayerEntry; label: string }) {
  const t = useTranslations("layers");
  const entry = item.overlayId ? OVERLAY_REGISTRY.find((r) => r.id === item.overlayId) : undefined;
  const active = entry?.useActive() ?? false;
  // Overlays declare a minimum usable zoom in their manifest; below it the tile
  // is disabled and explains itself rather than toggling on something that
  // would render nothing.
  const { minZoom, belowMinZoom } = useOverlayZoomGate(item.overlayId ?? "");

  return (
    <DesktopMoreTile
      item={{ ...item, selected: active && !belowMinZoom }}
      label={label}
      labelWidth={96}
      disabled={belowMinZoom}
      onClick={
        item.overlayId && !belowMinZoom
          ? () => {
              toggleOverlay(item.overlayId);
            }
          : undefined
      }
    >
      {belowMinZoom ? (
        <Typography sx={{ mt: 0.2, fontSize: 9, color: "text.secondary" }}>
          {t("zoomInHint", { minZoom })}
        </Typography>
      ) : null}
    </DesktopMoreTile>
  );
}

export function DesktopMorePanel({ onClose }: DesktopMorePanelProps) {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const globeView = useLayerStore((s) => s.globeView);
  const setGlobeView = useLayerStore((s) => s.setGlobeView);
  const measureActive = useMeasurementStore((s) => s.isActive);
  const travelTimeActive = useTravelTimeStore((s) => s.isActive);
  const { isAvailable } = useCapabilities();
  const { mapDetails, mapTools } = useLayerSelectorConfig();

  return (
    <Box
      sx={{
        px: 1.5,
        py: 1.2,
      }}
    >
      <Box
        sx={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          mb: 0.6,
        }}
      >
        <Typography sx={{ fontSize: 18, fontWeight: 700, color: "text.primary", lineHeight: 1 }}>
          {t("mapDetails")}
        </Typography>
        <IconButton
          onClick={onClose}
          aria-label={t("closeMorePanel")}
          sx={{ color: "text.primary", mt: -0.5 }}
        >
          <CloseIcon sx={{ fontSize: 23 }} />
        </IconButton>
      </Box>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {mapDetails
          .filter((item) => isAvailable(item.serviceId))
          .map((item) => (
            <OverlayDetailTile key={item.id} item={item} label={t(item.labelKey)} />
          ))}
      </Box>

      <Divider sx={{ my: 0.8 }} />

      <Typography
        sx={{ fontSize: 16, fontWeight: 700, color: "text.primary", lineHeight: 1, mb: 0.6 }}
      >
        {t("mapTools")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {mapTools.map((item) => {
          const toolState: Record<string, { active: boolean; toggle: () => void }> = {
            measurement: {
              active: measureActive,
              toggle: () => {
                const s = useMeasurementStore.getState();
                if (s.isActive) s.deactivate();
                else s.activate();
              },
            },
            "travel-time": {
              active: travelTimeActive,
              toggle: () => {
                const s = useTravelTimeStore.getState();
                if (s.isActive) s.deactivate();
                else s.activate();
              },
            },
          };
          const tool = toolState[item.id];
          return (
            <DesktopMoreTile
              key={item.id}
              item={{ ...item, selected: tool?.active }}
              label={t(item.labelKey)}
              labelWidth={96}
              onClick={
                tool
                  ? () => {
                      tool.toggle();
                    }
                  : undefined
              }
            />
          );
        })}
        <DesktopMoreTile
          item={{ preview: globePreview, selected: globeView }}
          label={t("globeView")}
          labelWidth={96}
          onClick={() => setGlobeView(!globeView)}
        />
      </Box>

      <Divider sx={{ my: 0.8 }} />

      <Typography
        sx={{ fontSize: 16, fontWeight: 700, color: "text.primary", lineHeight: 1, mb: 0.6 }}
      >
        {t("mapType")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {DESKTOP_MORE_MAP_TYPES.map((item) => (
          <DesktopMoreTile
            key={item.id}
            item={{ ...item, selected: item.id === activeLayer }}
            label={t(item.labelKey)}
            labelWidth={96}
            onClick={() => {
              setActiveLayer(item.id as MapLayer);
            }}
          />
        ))}
      </Box>
    </Box>
  );
}
