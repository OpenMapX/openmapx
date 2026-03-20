"use client";

import LayersIcon from "@mui/icons-material/Layers";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Popover from "@mui/material/Popover";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import {
  useCategorySearchStore,
  useLayerStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { FocusEvent, MouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";
import { TRAFFIC_MIN_ZOOM } from "../layers/trafficConfig";
import { DesktopMorePanel } from "./DesktopMorePanel";
import { DesktopQuickSelector } from "./DesktopQuickSelector";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import { MobileLayerPanel } from "./MobileLayerPanel";

export function LayerSelector() {
  const t = useTranslations("layers");
  const theme = useTheme();
  const desktopDock = useMediaQuery(theme.breakpoints.up("sm"));
  const { mapReady, mapRef } = useMap();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number | null>(null);
  const desktopAnchorRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const hasSidePanel = !collapsed && activeSidebarId !== null;
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const activeLayer = useLayerStore((s) => s.activeLayer);

  const hiddenByCategoryCard = activeCategory !== null && selectedPlace !== null;

  const activeBaseOption =
    BASE_LAYER_OPTIONS.find((option) => option.id === activeLayer) ?? BASE_LAYER_OPTIONS[0];

  const handleOpen = (event: MouseEvent<HTMLElement>) => {
    if (desktopDock && desktopAnchorRef.current) {
      setAnchorEl(desktopAnchorRef.current);
      return;
    }
    setAnchorEl(event.currentTarget);
  };

  const handleClose = () => {
    setAnchorEl(null);
  };

  const clearDesktopCloseTimer = () => {
    if (closeTimerRef.current === undefined) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  };

  const openDesktopSelector = () => {
    clearDesktopCloseTimer();
    setDesktopExpanded(true);
  };

  const scheduleDesktopClose = () => {
    clearDesktopCloseTimer();
    closeTimerRef.current = window.setTimeout(() => {
      setDesktopExpanded(false);
    }, 130);
  };

  const handleDesktopBlur = (event: FocusEvent<HTMLDivElement>) => {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    scheduleDesktopClose();
  };

  useEffect(() => {
    return () => {
      if (closeTimerRef.current === undefined) return;
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    };
  }, []);

  useEffect(() => {
    if (!desktopDock) {
      setDesktopExpanded(false);
      if (closeTimerRef.current === undefined) return;
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, [desktopDock]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const syncZoom = () => {
      setZoomLevel(map.getZoom());
    };

    syncZoom();
    map.on("zoom", syncZoom);
    return () => {
      map.off("zoom", syncZoom);
    };
  }, [mapReady, mapRef]);

  if (hiddenByCategoryCard) return null;

  const open = Boolean(anchorEl);
  const trafficZoomTooLow = zoomLevel !== null && zoomLevel < TRAFFIC_MIN_ZOOM;

  return (
    <>
      <Box
        ref={desktopAnchorRef}
        sx={{
          position: "absolute",
          bottom: 26,
          left: { xs: 12, sm: hasSidePanel ? 412 : 12 },
          transition: "left 0.25s ease",
          zIndex: 10,
        }}
      >
        {desktopDock ? (
          <Box sx={{ position: "relative" }}>
            <Box
              sx={{
                opacity: desktopExpanded ? 0 : 1,
                transform: desktopExpanded
                  ? "translateY(6px) scale(0.98)"
                  : "translateY(0) scale(1)",
                transition: "opacity 0.12s ease, transform 0.16s ease",
                pointerEvents: desktopExpanded ? "none" : "auto",
              }}
            >
              <ButtonBase
                onMouseEnter={openDesktopSelector}
                onMouseLeave={scheduleDesktopClose}
                onFocus={openDesktopSelector}
                onBlur={scheduleDesktopClose}
                onClick={openDesktopSelector}
                aria-label={t("openLayers")}
                aria-expanded={desktopExpanded ? "true" : "false"}
                sx={{ borderRadius: "14px", display: "block" }}
              >
                <Paper
                  elevation={4}
                  sx={{
                    width: 64,
                    height: 64,
                    borderRadius: "12px",
                    overflow: "hidden",
                    position: "relative",
                    border: "2px solid #fff",
                  }}
                >
                  <Box sx={{ width: "100%", height: "100%" }}>{activeBaseOption.preview}</Box>
                  <Box
                    sx={{
                      position: "absolute",
                      bottom: 0,
                      left: 0,
                      right: 0,
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 0.3,
                      py: 0.3,
                      background: "linear-gradient(transparent, rgba(255,255,255,0.85) 30%)",
                    }}
                  >
                    <LayersIcon sx={{ fontSize: 14, color: "text.secondary" }} />
                    <Typography
                      sx={{ fontSize: 11, lineHeight: 1, fontWeight: 600, color: "text.secondary" }}
                    >
                      {t("layers")}
                    </Typography>
                  </Box>
                </Paper>
              </ButtonBase>
            </Box>

            <Box
              id="map-layer-quick-selector"
              onMouseEnter={openDesktopSelector}
              onMouseLeave={scheduleDesktopClose}
              onFocusCapture={openDesktopSelector}
              onBlurCapture={handleDesktopBlur}
              sx={{
                position: "absolute",
                left: 0,
                bottom: 0,
                opacity: desktopExpanded ? 1 : 0,
                transform: desktopExpanded
                  ? "translateY(0) scale(1)"
                  : "translateY(6px) scale(0.98)",
                transformOrigin: "left bottom",
                transition: "opacity 0.12s ease, transform 0.16s ease",
                pointerEvents: desktopExpanded ? "auto" : "none",
              }}
            >
              <DesktopQuickSelector
                onMoreClick={handleOpen}
                trafficZoomTooLow={trafficZoomTooLow}
              />
            </Box>
          </Box>
        ) : (
          <Tooltip title={t("layers")} placement="right">
            <Paper elevation={3} sx={{ borderRadius: "12px", overflow: "hidden" }}>
              <IconButton
                onClick={handleOpen}
                aria-label={t("openLayerMenu")}
                aria-controls={open ? "map-layer-selector" : undefined}
                aria-expanded={open ? "true" : undefined}
                aria-haspopup="dialog"
                sx={{
                  width: 44,
                  height: 44,
                  color: "text.primary",
                }}
              >
                <LayersIcon sx={{ fontSize: 22 }} />
              </IconButton>
            </Paper>
          </Tooltip>
        )}
      </Box>

      <Popover
        id="map-layer-selector"
        open={open}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={
          desktopDock
            ? { vertical: "bottom", horizontal: "left" }
            : { vertical: "top", horizontal: "left" }
        }
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          paper: {
            sx: {
              mb: desktopDock ? 0 : 1.25,
              borderRadius: desktopDock ? "22px" : "16px",
              width: desktopDock ? "auto" : 346,
              minWidth: desktopDock ? 0 : undefined,
              maxHeight: desktopDock ? "min(76vh, 700px)" : "none",
              boxShadow: "0 4px 20px rgba(0,0,0,0.15), 0 1px 6px rgba(0,0,0,0.1)",
              bgcolor: "background.paper",
              overflowY: desktopDock ? "auto" : "visible",
            },
          },
        }}
      >
        {desktopDock ? (
          <DesktopMorePanel onClose={handleClose} />
        ) : (
          <MobileLayerPanel trafficZoomTooLow={trafficZoomTooLow} />
        )}
      </Popover>
    </>
  );
}
