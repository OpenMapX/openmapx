"use client";

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
import CloseIcon from "@mui/icons-material/Close";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import { OVERLAY_REGISTRY, toggleOverlay, useCapabilities, useLayerStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { useOverlayZoomGate } from "@/integration-api/overlay/overlayZoomGate";
import { DesktopMoreTile } from "./DesktopMoreTile";
import { globePreview } from "./layerPreviewSvgs";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

interface DesktopMorePanelProps {
  onClose: () => void;
}

function OverlayDetailTile({ item, label }: { item: GeneratedLayerEntry; label: string }) {
  const t = useTranslations("layers");
  const entry = item.overlayId ? OVERLAY_REGISTRY.find((r) => r.id === item.overlayId) : undefined;
  const active = entry?.useActive() ?? false;
  // Gate new selections, but keep an active overlay selected and removable.
  const { minZoom, belowMinZoom } = useOverlayZoomGate(item.overlayId ?? "");
  const disabled = belowMinZoom && !active;

  return (
    <DesktopMoreTile
      item={{ ...item, selected: active }}
      label={label}
      labelWidth={96}
      disabled={disabled}
      onClick={
        item.overlayId
          ? () => {
              if (!disabled) toggleOverlay(item.overlayId, { kind: "user" });
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

function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <Typography
      sx={{ fontSize: 16, fontWeight: 600, color: "text.primary", lineHeight: 1.5, mb: 0.5 }}
    >
      {children}
    </Typography>
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
  const { detailGroups, mapTools } = useLayerSelectorConfig();

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
        <SectionTitle>{t("mapDetails")}</SectionTitle>
        <IconButton onClick={onClose} aria-label={t("closeMorePanel")} size="small">
          <CloseIcon fontSize="small" />
        </IconButton>
      </Box>

      {detailGroups.map((group) => {
        const entries = group.entries.filter((item) => isAvailable(item.serviceId));
        if (entries.length === 0) return null;
        return (
          <Box key={group.id} sx={{ mb: 1 }}>
            <Typography sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary", mb: 0.5 }}>
              {t(group.id)}
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0,1fr))",
                justifyItems: "center",
                columnGap: 0.5,
                rowGap: 0.5,
              }}
            >
              {entries.map((item) => (
                <OverlayDetailTile key={item.id} item={item} label={t(item.labelKey)} />
              ))}
            </Box>
          </Box>
        );
      })}

      <Divider sx={{ my: 0.8 }} />

      <SectionTitle>{t("mapTools")}</SectionTitle>
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

      <SectionTitle>{t("mapType")}</SectionTitle>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {BASE_LAYER_OPTIONS.map((option) => (
          <DesktopMoreTile
            key={option.id}
            item={{ preview: option.preview, selected: option.id === activeLayer }}
            label={t(option.labelKey)}
            labelWidth={96}
            onClick={() => setActiveLayer(option.id)}
          />
        ))}
      </Box>
    </Box>
  );
}
