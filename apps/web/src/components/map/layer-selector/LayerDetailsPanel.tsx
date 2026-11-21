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
import {
  toggleGlobeLighting,
  useGlobeLightingActive,
} from "@/components/map/layers/globe/globeLighting";
import { useOverlayZoomGate } from "@/integration-api/overlay/overlayZoomGate";
import { LayerDetailsTile } from "./LayerDetailsTile";
import { globeLightingPreview, globePreview } from "./layerPreviewSvgs";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

interface LayerDetailsPanelProps {
  onClose: () => void;
  /**
   * `popover`: the desktop panel beside the map, details first and map type
   * last. `sheet`: the phone's bottom sheet, map type first and a wider grid.
   */
  variant?: "popover" | "sheet";
}

function OverlayDetailTile({
  item,
  label,
  labelWidth,
}: {
  item: GeneratedLayerEntry;
  label: string;
  labelWidth: number;
}) {
  const t = useTranslations("layers");
  const entry = item.overlayId ? OVERLAY_REGISTRY.find((r) => r.id === item.overlayId) : undefined;
  const active = entry?.useActive() ?? false;
  // Gate new selections, but keep an active overlay selected and removable.
  const { minZoom, belowMinZoom } = useOverlayZoomGate(item.overlayId ?? "");
  const disabled = belowMinZoom && !active;

  return (
    <LayerDetailsTile
      item={{ ...item, selected: active }}
      label={label}
      labelWidth={labelWidth}
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
    </LayerDetailsTile>
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

function TileGrid({ columns, children }: { columns: number; children: ReactNode }) {
  return (
    <Box
      sx={{
        display: "grid",
        gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`,
        justifyItems: "center",
        columnGap: 0.5,
        rowGap: 0.5,
      }}
    >
      {children}
    </Box>
  );
}

/** Map type, map details and map tools as tile grids, shared by the desktop panel and the phone sheet. */
export function LayerDetailsPanel({ onClose, variant = "popover" }: LayerDetailsPanelProps) {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const globeView = useLayerStore((s) => s.globeView);
  const setGlobeView = useLayerStore((s) => s.setGlobeView);
  const globeLighting = useGlobeLightingActive();
  const measureActive = useMeasurementStore((s) => s.isActive);
  const travelTimeActive = useTravelTimeStore((s) => s.isActive);
  const { isAvailable } = useCapabilities();
  const { detailGroups, mapTools } = useLayerSelectorConfig();
  const sheet = variant === "sheet";
  const columns = sheet ? 4 : 3;
  const labelWidth = sheet ? 80 : 96;

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

  const closeButton = (
    <IconButton onClick={onClose} aria-label={t("closeMorePanel")} size="small">
      <CloseIcon fontSize="small" />
    </IconButton>
  );
  const titleRow = (title: string) => (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "space-between", mb: 0.6 }}>
      <SectionTitle>{title}</SectionTitle>
      {closeButton}
    </Box>
  );

  const mapType = (
    <TileGrid columns={sheet ? 4 : 2}>
      {BASE_LAYER_OPTIONS.map((option) => (
        <LayerDetailsTile
          key={option.id}
          item={{ preview: option.preview, selected: option.id === activeLayer }}
          label={t(option.labelKey)}
          labelWidth={labelWidth}
          onClick={() => setActiveLayer(option.id)}
        />
      ))}
    </TileGrid>
  );

  const details = detailGroups.map((group) => {
    const entries = group.entries.filter((item) => isAvailable(item.serviceId));
    if (entries.length === 0) return null;
    return (
      <Box key={group.id} sx={{ mb: 1 }}>
        <Typography sx={{ fontSize: 13, fontWeight: 600, color: "text.secondary", mb: 0.5 }}>
          {t(group.id)}
        </Typography>
        <TileGrid columns={columns}>
          {entries.map((item) => (
            <OverlayDetailTile
              key={item.id}
              item={item}
              label={t(item.labelKey)}
              labelWidth={labelWidth}
            />
          ))}
        </TileGrid>
      </Box>
    );
  });

  const tools = (
    <TileGrid columns={columns}>
      {mapTools.map((item) => {
        const tool = toolState[item.id];
        return (
          <LayerDetailsTile
            key={item.id}
            item={{ ...item, selected: tool?.active }}
            label={t(item.labelKey)}
            labelWidth={labelWidth}
            onClick={tool?.toggle}
          />
        );
      })}
      <LayerDetailsTile
        item={{ preview: globePreview, selected: globeView }}
        label={t("globeView")}
        labelWidth={labelWidth}
        onClick={() => setGlobeView(!globeView)}
      />
      {globeView ? (
        <LayerDetailsTile
          item={{ preview: globeLightingPreview, selected: globeLighting }}
          label={t("globeLighting")}
          labelWidth={labelWidth}
          onClick={toggleGlobeLighting}
        />
      ) : null}
    </TileGrid>
  );

  return (
    <Box sx={{ px: sheet ? 2 : 1.5, py: 1.2 }}>
      {sheet ? (
        <>
          {titleRow(t("mapType"))}
          {mapType}
          <Divider sx={{ my: 1.5 }} />
          <SectionTitle>{t("mapDetails")}</SectionTitle>
          {details}
          <Divider sx={{ my: 1 }} />
          <SectionTitle>{t("mapTools")}</SectionTitle>
          {tools}
        </>
      ) : (
        <>
          {titleRow(t("mapDetails"))}
          {details}
          <Divider sx={{ my: 0.8 }} />
          <SectionTitle>{t("mapTools")}</SectionTitle>
          {tools}
          <Divider sx={{ my: 0.8 }} />
          <SectionTitle>{t("mapType")}</SectionTitle>
          {mapType}
        </>
      )}
    </Box>
  );
}
