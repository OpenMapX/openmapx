"use client";

import LayersIcon from "@mui/icons-material/Layers";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import Paper from "@mui/material/Paper";
import Typography from "@mui/material/Typography";
import { OVERLAY_REGISTRY, toggleOverlay, useLayerStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { MouseEvent } from "react";
import { TEAL } from "@/lib/theme";
import { TRAFFIC_MIN_ZOOM } from "../layers/trafficConfig";
import { BASE_LAYER_OPTIONS, DETAIL_OPTIONS } from "./layerSelectorConfig";

interface DesktopQuickSelectorProps {
  onMoreClick: (event: MouseEvent<HTMLElement>) => void;
  trafficZoomTooLow: boolean;
}

function DetailOptionTile({
  option,
  trafficZoomTooLow,
}: {
  option: (typeof DETAIL_OPTIONS)[number];
  trafficZoomTooLow: boolean;
}) {
  const t = useTranslations("layers");
  const showTraffic = useLayerStore((s) => s.showTraffic);
  const setShowTraffic = useLayerStore((s) => s.setShowTraffic);
  const showTransit = useLayerStore((s) => s.showTransit);
  const setShowTransit = useLayerStore((s) => s.setShowTransit);
  const overlayEntry = option.overlayId
    ? OVERLAY_REGISTRY.find((r) => r.id === option.overlayId)
    : undefined;
  const overlayActive = overlayEntry?.useActive() ?? false;

  const disabled = option.key === "traffic" && trafficZoomTooLow;
  const checked =
    option.key === "traffic" ? showTraffic : option.overlayId ? overlayActive : showTransit;
  const highlighted = checked && !disabled;
  const label = t(option.labelKey);
  const onClick = () => {
    if (disabled) return;
    if (option.key === "traffic") setShowTraffic(!showTraffic);
    else if (option.overlayId) toggleOverlay(option.overlayId);
    else setShowTransit(!showTransit);
  };

  return (
    <ButtonBase
      onClick={onClick}
      aria-label={t("toggleOverlay", { layer: label })}
      aria-disabled={disabled ? "true" : "false"}
      sx={{
        width: 72,
        minWidth: 72,
        borderRadius: "12px",
        p: 0.5,
        textAlign: "center",
        opacity: disabled ? 0.42 : 1,
        filter: disabled ? "grayscale(1)" : "none",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      <Box sx={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <Box
          sx={{
            width: 48,
            height: 48,
            borderRadius: "10px",
            overflow: "hidden",
            mb: 0.3,
            border: highlighted ? `2px solid ${TEAL}` : "2px solid transparent",
          }}
        >
          {option.preview}
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
          <Box sx={{ display: "flex", color: highlighted ? TEAL : "text.secondary" }}>
            {option.icon}
          </Box>
          <Typography
            sx={{
              fontSize: 11,
              lineHeight: 1.15,
              color: highlighted ? TEAL : "text.secondary",
              fontWeight: highlighted ? 600 : 500,
            }}
          >
            {label}
          </Typography>
        </Box>
        {disabled ? (
          <Typography sx={{ mt: 0.2, fontSize: 9, color: "text.secondary" }}>
            Zoom {TRAFFIC_MIN_ZOOM}+
          </Typography>
        ) : null}
      </Box>
    </ButtonBase>
  );
}

export function DesktopQuickSelector({
  onMoreClick,
  trafficZoomTooLow,
}: DesktopQuickSelectorProps) {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);

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
          <ButtonBase
            key={option.id}
            onClick={() => setActiveLayer(option.id)}
            aria-label={t("useMap", { layer: label })}
            sx={{
              width: 72,
              minWidth: 72,
              borderRadius: "12px",
              p: 0.5,
              textAlign: "center",
            }}
          >
            <Box
              sx={{ width: "100%", display: "flex", flexDirection: "column", alignItems: "center" }}
            >
              <Box
                sx={{
                  width: 48,
                  height: 48,
                  borderRadius: "10px",
                  overflow: "hidden",
                  mb: 0.3,
                  border: selected ? `2px solid ${TEAL}` : "2px solid transparent",
                }}
              >
                {option.preview}
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
                <Box sx={{ display: "flex", color: selected ? TEAL : "text.secondary" }}>
                  {option.icon}
                </Box>
                <Typography
                  sx={{
                    fontSize: 11,
                    lineHeight: 1.15,
                    color: selected ? TEAL : "text.secondary",
                    fontWeight: selected ? 600 : 500,
                  }}
                >
                  {label}
                </Typography>
              </Box>
            </Box>
          </ButtonBase>
        );
      })}

      <Divider orientation="vertical" flexItem sx={{ my: 0.4 }} />

      {DETAIL_OPTIONS.map((option) => (
        <DetailOptionTile key={option.key} option={option} trafficZoomTooLow={trafficZoomTooLow} />
      ))}

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
              bgcolor: "rgba(60,64,67,0.06)",
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
