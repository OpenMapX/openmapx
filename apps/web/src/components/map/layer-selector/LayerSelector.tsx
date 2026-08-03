"use client";

import LayersIcon from "@mui/icons-material/Layers";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Popover, { type PopoverActions } from "@mui/material/Popover";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import { useLayerStore, useNavigationStore, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { FocusEvent, MouseEvent, TransitionEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { LAYER_SELECTOR_OPEN_EVENT } from "@/components/command-palette/constants";
import { isPanelShiftActive, PANEL_WIDTH, shouldHideLayerSelector } from "@/lib/layout";
import { DesktopMorePanel } from "./DesktopMorePanel";
import { DesktopQuickSelector } from "./DesktopQuickSelector";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import { MobileLayerPanel } from "./MobileLayerPanel";

export function LayerSelector() {
  const t = useTranslations("layers");
  const theme = useTheme();
  const desktopDock = useMediaQuery(theme.breakpoints.up("sm"));
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const desktopAnchorRef = useRef<HTMLDivElement | null>(null);
  const popoverActionRef = useRef<PopoverActions | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const activeSidebarId = useSidebarStore((s) => s.activeSidebarId);
  const activeDetailId = useSidebarStore((s) => s.activeDetailId);
  const collapsed = useSidebarStore((s) => s.collapsed);
  const hasSidePanel = !collapsed && activeSidebarId !== null;
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const activeLayer = useLayerStore((s) => s.activeLayer);

  const panelShiftActive = isPanelShiftActive({
    sidebarOpen: activeSidebarId !== null,
    sidebarCollapsed: collapsed,
    navigating,
  });
  const hiddenByFloatingCard = shouldHideLayerSelector({
    desktop: desktopDock,
    detailOpen: activeDetailId !== null,
    sidebarOpen: hasSidePanel,
    selectedPlace: selectedPlace !== null,
  });

  const activeBaseOption =
    BASE_LAYER_OPTIONS.find((option) => option.id === activeLayer) ?? BASE_LAYER_OPTIONS[0];

  const clearDesktopCloseTimer = () => {
    if (closeTimerRef.current === undefined) return;
    window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = undefined;
  };

  const handleAnchorTransitionEnd = (event: TransitionEvent<HTMLDivElement>) => {
    if (!desktopDock || !anchorEl || event.propertyName !== "left") return;
    popoverActionRef.current?.updatePosition();
  };

  const handleOpen = (event: MouseEvent<HTMLElement>) => {
    // The "Map Details" panel supersedes the quick selector — collapse it right
    // away. It is usually opened from the quick selector's own "More" tile, so
    // neither the mouse-leave nor the blur heuristic below fires on its own
    // (the pointer stays on the tile, and the popover keeps focus where it is).
    clearDesktopCloseTimer();
    setDesktopExpanded(false);
    if (desktopDock && desktopAnchorRef.current) {
      setAnchorEl(desktopAnchorRef.current);
      return;
    }
    setAnchorEl((current) => (current ? null : event.currentTarget));
  };

  const handleClose = () => {
    setAnchorEl(null);
    setDesktopExpanded(false);
  };

  const openDesktopSelector = () => {
    // Hovering or focusing the dock must not bring the quick selector back
    // underneath an open panel — the popover has no backdrop on desktop, so
    // pointer events still reach the dock behind it.
    if (anchorEl) return;
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

  // Allow the command palette (and other callers) to open the layer selector
  // programmatically by dispatching `LAYER_SELECTOR_OPEN_EVENT`. We only open
  // the full "Map Details" popover, collapsing the desktop quick-selector dock
  // if it happened to be expanded (both showing at once is never wanted).
  useEffect(() => {
    const onOpen = () => {
      if (!desktopAnchorRef.current) return;
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = undefined;
      }
      setDesktopExpanded(false);
      setAnchorEl(desktopAnchorRef.current);
    };
    window.addEventListener(LAYER_SELECTOR_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(LAYER_SELECTOR_OPEN_EVENT, onOpen);
  }, []);

  useEffect(() => {
    if (!desktopDock) {
      setDesktopExpanded(false);
      if (closeTimerRef.current === undefined) return;
      window.clearTimeout(closeTimerRef.current);
      closeTimerRef.current = undefined;
    }
  }, [desktopDock]);

  const open = Boolean(anchorEl);

  return (
    <>
      <Box
        ref={desktopAnchorRef}
        onTransitionEnd={handleAnchorTransitionEnd}
        sx={{
          position: "absolute",
          bottom: 26,
          left: { xs: 12, sm: panelShiftActive ? PANEL_WIDTH + 12 : 12 },
          transition: "left 0.25s ease, opacity 0.18s ease",
          zIndex: 10,
          ...(hiddenByFloatingCard
            ? {
                width: 1,
                height: 1,
                opacity: 0,
                pointerEvents: "none",
              }
            : null),
        }}
      >
        {hiddenByFloatingCard ? null : desktopDock ? (
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
                    border: "2px solid var(--omx-overlay-bg)",
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
                      background: "linear-gradient(transparent, var(--omx-overlay-bg) 30%)",
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
              <DesktopQuickSelector onMoreClick={handleOpen} />
            </Box>
          </Box>
        ) : (
          <Tooltip title={t("layers")} placement="right">
            <Paper elevation={3} sx={{ borderRadius: "50%", overflow: "hidden" }}>
              <IconButton
                onClick={handleOpen}
                aria-label={t("openLayerMenu")}
                aria-controls={open ? "map-layer-selector" : undefined}
                aria-expanded={open ? "true" : undefined}
                aria-haspopup="dialog"
                sx={{
                  width: 44,
                  height: 44,
                  borderRadius: "50%",
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
        action={popoverActionRef}
        onClose={handleClose}
        disableScrollLock
        disableEnforceFocus
        disableAutoFocus
        disableRestoreFocus
        hideBackdrop={desktopDock}
        anchorOrigin={
          desktopDock
            ? { vertical: "bottom", horizontal: "left" }
            : { vertical: "top", horizontal: "left" }
        }
        transformOrigin={{ vertical: "bottom", horizontal: "left" }}
        slotProps={{
          root: desktopDock ? { sx: { pointerEvents: "none" } } : undefined,
          backdrop: desktopDock ? undefined : { invisible: true },
          paper: {
            sx: {
              pointerEvents: "auto",
              mb: desktopDock ? 0 : 1.25,
              borderRadius: desktopDock ? "22px" : "16px",
              width: desktopDock ? "auto" : 346,
              minWidth: desktopDock ? 0 : undefined,
              maxHeight: desktopDock ? "min(76vh, 700px)" : "none",
              boxShadow: "0 4px 20px var(--omx-shadow-soft), 0 1px 6px var(--omx-shadow-soft)",
              bgcolor: "background.paper",
              overflowY: desktopDock ? "auto" : "visible",
            },
          },
        }}
      >
        {desktopDock ? <DesktopMorePanel onClose={handleClose} /> : <MobileLayerPanel />}
      </Popover>
    </>
  );
}
