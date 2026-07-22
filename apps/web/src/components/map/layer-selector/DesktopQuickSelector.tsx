"use client";

import LayersIcon from "@mui/icons-material/Layers";
import PublicIcon from "@mui/icons-material/Public";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import {
  toggleOverlay,
  useCapabilities,
  useIntegrationOverlayActive,
  useLayerStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { MouseEvent } from "react";
import { useOverlayZoomGate } from "@/lib/overlayZoomGate";
import { LayerPreviewTile } from "./LayerPreviewTile";
import { globePreview } from "./layerPreviewSvgs";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

interface DesktopQuickSelectorProps {
  onMoreClick: (event: MouseEvent<HTMLElement>) => void;
}

function DetailOptionTile({ entry }: { entry: GeneratedLayerEntry }) {
  const t = useTranslations("layers");
  const overlayActive = useIntegrationOverlayActive(entry.overlayId);

  // Overlays declare a minimum usable zoom in their manifest; below it the tile
  // is disabled and explains itself rather than toggling on something that
  // would render nothing.
  const { minZoom, belowMinZoom } = useOverlayZoomGate(entry.overlayId);
  const disabled = belowMinZoom;
  const highlighted = overlayActive && !disabled;
  const label = t(entry.labelKey);

  return (
    <Box sx={{ width: 72, minWidth: 72, p: 0.5, display: "flex", justifyContent: "center" }}>
      <LayerPreviewTile
        preview={entry.preview}
        label={label}
        selected={highlighted}
        icon={entry.icon}
        disabled={disabled}
        onClick={() => {
          if (!disabled) toggleOverlay(entry.overlayId);
        }}
      >
        {disabled ? (
          <Typography sx={{ mt: 0.2, fontSize: 9, color: "text.secondary" }}>
            {t("zoomInHint", { minZoom })}
          </Typography>
        ) : null}
      </LayerPreviewTile>
    </Box>
  );
}

function GlobeTile() {
  const t = useTranslations("layers");
  const globeView = useLayerStore((s) => s.globeView);
  const setGlobeView = useLayerStore((s) => s.setGlobeView);

  return (
    <Box sx={{ width: 72, minWidth: 72, p: 0.5, display: "flex", justifyContent: "center" }}>
      <LayerPreviewTile
        preview={globePreview}
        label={t("globeView")}
        selected={globeView}
        icon={<PublicIcon sx={{ fontSize: 14 }} />}
        onClick={() => setGlobeView(!globeView)}
      />
    </Box>
  );
}

export function DesktopQuickSelector({ onMoreClick }: DesktopQuickSelectorProps) {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const { isAvailable } = useCapabilities();
  const { quickDetails } = useLayerSelectorConfig();

  return (
    <Paper
      elevation={4}
      sx={{
        borderRadius: "14px",
        p: 0.75,
        display: "flex",
        alignItems: "stretch",
        gap: 0.1,
        maxWidth: "calc(100vw - 24px)",
        overflowX: "auto",
      }}
    >
      {BASE_LAYER_OPTIONS.map((option) => {
        const selected = option.id === activeLayer;
        const label = t(option.labelKey);
        return (
          <Box
            key={option.id}
            sx={{ width: 72, minWidth: 72, p: 0.5, display: "flex", justifyContent: "center" }}
          >
            <LayerPreviewTile
              preview={option.preview}
              label={label}
              selected={selected}
              icon={option.icon}
              onClick={() => setActiveLayer(option.id)}
            />
          </Box>
        );
      })}

      <Divider orientation="vertical" flexItem sx={{ my: 0.4 }} />

      {quickDetails
        .filter((entry) => isAvailable(entry.serviceId))
        .map((entry) => (
          <DetailOptionTile key={entry.id} entry={entry} />
        ))}

      <GlobeTile />

      <ButtonBase
        onClick={onMoreClick}
        aria-label={t("openAdvancedMenu")}
        sx={{
          width: 80,
          minWidth: 80,
          borderRadius: "12px",
          p: 0.5,
          textAlign: "center",
          border: "2px solid transparent",
        }}
      >
        <Box sx={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
          <Box
            sx={{
              width: 48,
              height: 48,
              borderRadius: "10px",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              bgcolor: "var(--omx-hover-bg)",
              mb: 0.3,
              color: "text.secondary",
            }}
          >
            <LayersIcon sx={{ fontSize: 24 }} />
          </Box>
          <Typography
            sx={{ fontSize: 11, lineHeight: 1.15, fontWeight: 500, color: "text.secondary" }}
          >
            {t("more")}
          </Typography>
        </Box>
      </ButtonBase>
    </Paper>
  );
}
