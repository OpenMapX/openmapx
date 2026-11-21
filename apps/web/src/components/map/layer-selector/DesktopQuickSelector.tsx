"use client";

import LayersIcon from "@mui/icons-material/Layers";
import Box from "@mui/material/Box";
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
import { useOverlayZoomGate } from "@/integration-api/overlay/overlayZoomGate";
import { LayerPreviewTile } from "./LayerPreviewTile";
import { globeLightingPreview, globePreview } from "./layerPreviewSvgs";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

interface DesktopQuickSelectorProps {
  onMoreClick: (event: MouseEvent<HTMLElement>) => void;
}

function DetailOptionTile({ entry }: { entry: GeneratedLayerEntry }) {
  const t = useTranslations("layers");
  const overlayActive = useIntegrationOverlayActive(entry.overlayId);

  // Gate new selections, but keep an active overlay selected and removable.
  const { minZoom, belowMinZoom } = useOverlayZoomGate(entry.overlayId);
  const disabled = belowMinZoom && !overlayActive;
  const label = t(entry.labelKey);

  return (
    <Box sx={{ width: 72, minWidth: 72, p: 0.5, display: "flex", justifyContent: "center" }}>
      <LayerPreviewTile
        preview={entry.preview}
        label={label}
        selected={overlayActive}
        disabled={disabled}
        onClick={() => {
          if (!disabled) toggleOverlay(entry.overlayId, { kind: "user" });
        }}
      >
        {belowMinZoom ? (
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
        onClick={() => setGlobeView(!globeView)}
      />
    </Box>
  );
}

function GlobeLightingTile() {
  const t = useTranslations("layers");
  const globeLighting = useLayerStore((s) => s.globeLighting);
  const setGlobeLighting = useLayerStore((s) => s.setGlobeLighting);

  return (
    <Box sx={{ width: 72, minWidth: 72, p: 0.5, display: "flex", justifyContent: "center" }}>
      <LayerPreviewTile
        preview={globeLightingPreview}
        label={t("globeLighting")}
        selected={globeLighting}
        onClick={() => setGlobeLighting(!globeLighting)}
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
  const globeView = useLayerStore((s) => s.globeView);

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
      {globeView ? <GlobeLightingTile /> : null}

      <Box sx={{ width: 72, minWidth: 72, p: 0.5, display: "flex", justifyContent: "center" }}>
        <LayerPreviewTile
          preview={
            <Box
              sx={{
                height: "100%",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                bgcolor: "var(--omx-hover-bg)",
                color: "text.secondary",
              }}
            >
              <LayersIcon />
            </Box>
          }
          label={t("more")}
          ariaLabel={t("openAdvancedMenu")}
          onClick={onMoreClick}
        />
      </Box>
    </Paper>
  );
}
