"use client";

import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import CloseIcon from "@mui/icons-material/Close";
import DirectionsTransitFilledIcon from "@mui/icons-material/DirectionsTransitFilled";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import LayersIcon from "@mui/icons-material/Layers";
import MapOutlinedIcon from "@mui/icons-material/MapOutlined";
import SatelliteAltIcon from "@mui/icons-material/SatelliteAlt";
import TerrainIcon from "@mui/icons-material/Terrain";
import TrafficIcon from "@mui/icons-material/Traffic";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import IconButton from "@mui/material/IconButton";
import Paper from "@mui/material/Paper";
import Popover from "@mui/material/Popover";
import Switch from "@mui/material/Switch";
import { useTheme } from "@mui/material/styles";
import Tooltip from "@mui/material/Tooltip";
import Typography from "@mui/material/Typography";
import useMediaQuery from "@mui/material/useMediaQuery";
import type { MapLayer } from "@openmapx/core";
import { useLayerStore } from "@openmapx/core";
import type { FocusEvent, MouseEvent, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import { useMap } from "@/lib/MapContext";
import { TRAFFIC_MIN_ZOOM } from "./layers/trafficConfig";

interface BaseLayerOption {
  id: MapLayer;
  label: string;
  icon: ReactNode;
  preview: string;
}

interface DetailOption {
  key: "traffic" | "transit";
  label: string;
  icon: ReactNode;
  preview: string;
}

interface DesktopMoreOption {
  id: string;
  label: string;
  preview: string;
  selected?: boolean;
}

const BASE_LAYER_OPTIONS: BaseLayerOption[] = [
  {
    id: "default",
    label: "Default",
    icon: <MapOutlinedIcon sx={{ fontSize: 16 }} />,
    preview:
      "linear-gradient(135deg, rgba(204,220,255,1) 0%, rgba(223,240,223,1) 38%, rgba(240,240,240,1) 72%, rgba(250,229,199,1) 100%)",
  },
  {
    id: "satellite",
    label: "Satellite",
    icon: <SatelliteAltIcon sx={{ fontSize: 16 }} />,
    preview:
      "radial-gradient(circle at 20% 20%, rgba(104,136,98,1) 0%, rgba(69,96,64,1) 42%, rgba(45,60,42,1) 100%)",
  },
  {
    id: "terrain",
    label: "Terrain",
    icon: <TerrainIcon sx={{ fontSize: 16 }} />,
    preview: "linear-gradient(145deg, #6c8f61 0%, #9cb082 34%, #c9b58f 70%, #a08e70 100%)",
  },
];

const DETAIL_OPTIONS: DetailOption[] = [
  {
    key: "traffic",
    label: "Traffic",
    icon: <TrafficIcon sx={{ fontSize: 14 }} />,
    preview:
      "linear-gradient(145deg, #fef3c7 0%, #fdba74 26%, #fb7185 58%, #dc2626 100%), repeating-linear-gradient(45deg, rgba(255,255,255,0.2) 0, rgba(255,255,255,0.2) 4px, transparent 4px, transparent 8px)",
  },
  {
    key: "transit",
    label: "Transit",
    icon: <DirectionsTransitFilledIcon sx={{ fontSize: 14 }} />,
    preview:
      "linear-gradient(145deg, #dbeafe 0%, #bfdbfe 42%, #86efac 100%), repeating-linear-gradient(-40deg, rgba(26,115,232,0.25) 0, rgba(26,115,232,0.25) 3px, transparent 3px, transparent 7px)",
  },
];

const DESKTOP_MORE_MAP_DETAILS: readonly DesktopMoreOption[] = [
  {
    id: "public-transport",
    label: "Öffentliche\nVerkehrsmittel",
    preview:
      "linear-gradient(145deg,#e8edf2 0%,#d9dde2 48%,#f7f8f9 100%), linear-gradient(90deg,#6d60db 0%,#6d60db 36%,#3d7bf3 36%,#3d7bf3 67%,#56b6dc 67%,#56b6dc 100%)",
  },
  {
    id: "traffic",
    label: "Verkehr",
    preview:
      "linear-gradient(145deg,#b8dfcc 0%,#d9e4e8 40%,#b8d8d2 100%), linear-gradient(90deg,#2dd4bf 0%,#2dd4bf 30%,#facc15 30%,#facc15 48%,#ef4444 48%,#ef4444 66%,#3b82f6 66%,#3b82f6 100%)",
  },
  {
    id: "cycling",
    label: "Radfahren",
    preview:
      "radial-gradient(circle at 58% 45%,#9ad5cd 0%,#9ad5cd 23%,transparent 24%), linear-gradient(150deg,#d5e3e8 0%,#bdcad6 45%,#dce9ee 100%), linear-gradient(95deg,#2f9d76 0%,#2f9d76 28%,#e9eef4 28%,#e9eef4 46%,#1d7f63 46%,#1d7f63 62%,#d7dee6 62%,#d7dee6 100%)",
  },
  {
    id: "terrain",
    label: "Gelände",
    preview:
      "linear-gradient(145deg,#99a394 0%,#7c8577 36%,#c7d0c2 100%), radial-gradient(circle at 30% 35%,#6f776b 0%,#6f776b 22%,transparent 23%)",
  },
  {
    id: "street-view",
    label: "Street View",
    preview:
      "linear-gradient(150deg,#d4e5eb 0%,#bcd7d1 40%,#c5d8df 100%), radial-gradient(circle at 52% 32%,#f6be3f 0%,#f6be3f 18%,transparent 19%)",
  },
  {
    id: "wildfire",
    label: "Waldbrände",
    preview:
      "linear-gradient(150deg,#c6e7f4 0%,#c7efd8 46%,#dce2ee 100%), radial-gradient(circle at 52% 52%,#ef4444 0%,#ef4444 26%,transparent 27%)",
  },
  {
    id: "air-quality",
    label: "Luftqualität",
    preview:
      "linear-gradient(150deg,#bde2f0 0%,#bee8d6 48%,#d5deea 100%), radial-gradient(circle at 45% 52%,#6aa53f 0%,#6aa53f 26%,transparent 27%)",
  },
];

const DESKTOP_MORE_MAP_TOOLS: readonly DesktopMoreOption[] = [
  {
    id: "travel-time",
    label: "Reisedauer",
    preview:
      "linear-gradient(150deg,#bee0ef 0%,#c7e9d8 45%,#d6deea 100%), radial-gradient(circle at 40% 46%,#4f83f1 0%,#4f83f1 4%,transparent 5%)",
  },
  {
    id: "measure",
    label: "Messen",
    preview:
      "linear-gradient(150deg,#bee0ef 0%,#c7e9d8 45%,#d6deea 100%), linear-gradient(130deg,transparent 0%,transparent 46%,#111827 46%,#111827 54%,transparent 54%,transparent 100%)",
  },
];

const DESKTOP_MORE_MAP_TYPES: readonly DesktopMoreOption[] = [
  {
    id: "standard",
    label: "Standard",
    preview:
      "linear-gradient(145deg,rgba(204,220,255,1) 0%, rgba(223,240,223,1) 38%, rgba(240,240,240,1) 72%, rgba(250,229,199,1) 100%)",
    selected: false,
  },
  {
    id: "satellite",
    label: "Satellit",
    preview:
      "radial-gradient(circle at 20% 20%, rgba(104,136,98,1) 0%, rgba(69,96,64,1) 42%, rgba(45,60,42,1) 100%)",
    selected: true,
  },
];

function DesktopMoreTile({
  item,
  labelWidth = 132,
}: {
  item: DesktopMoreOption;
  labelWidth?: number;
}) {
  return (
    <Box
      sx={{
        minHeight: 100,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
      }}
    >
      <Box
        sx={{
          width: 74,
          height: 68,
          borderRadius: "11px",
          background: item.preview,
          border: item.selected ? "2px solid #0b7d8b" : "1px solid rgba(60,64,67,0.14)",
          boxShadow: item.selected ? "0 0 0 1px rgba(11,125,139,0.22)" : "none",
        }}
      />
      <Typography
        sx={{
          mt: 0.58,
          fontSize: 12.5,
          color: item.selected ? "#0b7d8b" : "#3c4043",
          lineHeight: 1.2,
          whiteSpace: "pre-line",
          width: labelWidth,
          textAlign: "center",
        }}
      >
        {item.label}
      </Typography>
    </Box>
  );
}

export function LayerSelector() {
  const theme = useTheme();
  const desktopDock = useMediaQuery(theme.breakpoints.up("sm"));
  const { mapReady, mapRef } = useMap();
  const [anchorEl, setAnchorEl] = useState<HTMLElement | null>(null);
  const [desktopExpanded, setDesktopExpanded] = useState(false);
  const [zoomLevel, setZoomLevel] = useState<number | null>(null);
  const desktopAnchorRef = useRef<HTMLDivElement | null>(null);
  const closeTimerRef = useRef<number | undefined>(undefined);
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const showTraffic = useLayerStore((s) => s.showTraffic);
  const showTransit = useLayerStore((s) => s.showTransit);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const setShowTraffic = useLayerStore((s) => s.setShowTraffic);
  const setShowTransit = useLayerStore((s) => s.setShowTransit);

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

  const open = Boolean(anchorEl);
  const trafficZoomTooLow = zoomLevel !== null && zoomLevel < TRAFFIC_MIN_ZOOM;

  const quickSelector = (
    <Paper
      elevation={4}
      sx={{
        borderRadius: "14px",
        p: 0.9,
        display: "flex",
        alignItems: "stretch",
        gap: 0.8,
        maxWidth: "calc(100vw - 24px)",
        overflowX: "auto",
      }}
    >
      {BASE_LAYER_OPTIONS.map((option) => {
        const selected = option.id === activeLayer;
        return (
          <ButtonBase
            key={option.id}
            onClick={() => setActiveLayer(option.id)}
            aria-label={`Use ${option.label} map`}
            sx={{
              width: 72,
              minWidth: 72,
              borderRadius: "10px",
              p: 0.6,
              textAlign: "left",
              border: selected ? "2px solid #1A73E8" : "1px solid rgba(60,64,67,0.2)",
              boxShadow: selected ? "0 0 0 1px rgba(26,115,232,0.15)" : "none",
            }}
          >
            <Box sx={{ width: "100%" }}>
              <Box
                sx={{
                  width: "100%",
                  height: 40,
                  borderRadius: "7px",
                  background: option.preview,
                  mb: 0.45,
                }}
              />
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
                <Box sx={{ display: "flex", color: "text.secondary" }}>{option.icon}</Box>
                <Typography
                  sx={{
                    fontSize: 11.5,
                    lineHeight: 1.15,
                    color: selected ? "text.primary" : "text.secondary",
                    fontWeight: selected ? 600 : 500,
                  }}
                >
                  {option.label}
                </Typography>
              </Box>
            </Box>
          </ButtonBase>
        );
      })}

      <Divider orientation="vertical" flexItem sx={{ my: 0.4 }} />

      {DETAIL_OPTIONS.map((option) => {
        const disabled = option.key === "traffic" && trafficZoomTooLow;
        const checked = option.key === "traffic" ? showTraffic : showTransit;
        const highlighted = checked && !disabled;
        const onClick = () => {
          if (disabled) return;
          if (option.key === "traffic") setShowTraffic(!showTraffic);
          else setShowTransit(!showTransit);
        };

        return (
          <ButtonBase
            key={option.key}
            onClick={onClick}
            aria-label={`Toggle ${option.label} overlay`}
            aria-disabled={disabled ? "true" : "false"}
            sx={{
              width: 72,
              minWidth: 72,
              borderRadius: "10px",
              p: 0.6,
              textAlign: "left",
              border: highlighted ? "2px solid #1A73E8" : "1px solid rgba(60,64,67,0.2)",
              boxShadow: highlighted ? "0 0 0 1px rgba(26,115,232,0.15)" : "none",
              opacity: disabled ? 0.42 : 1,
              filter: disabled ? "grayscale(1)" : "none",
              cursor: disabled ? "not-allowed" : "pointer",
            }}
          >
            <Box sx={{ width: "100%" }}>
              <Box
                sx={{
                  width: "100%",
                  height: 40,
                  borderRadius: "7px",
                  background: option.preview,
                  mb: 0.45,
                }}
              />
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.3 }}>
                <Box sx={{ display: "flex", color: "text.secondary" }}>{option.icon}</Box>
                <Typography
                  sx={{
                    fontSize: 11.5,
                    lineHeight: 1.15,
                    color: highlighted ? "text.primary" : "text.secondary",
                    fontWeight: highlighted ? 600 : 500,
                  }}
                >
                  {option.label}
                </Typography>
              </Box>
              {disabled ? (
                <Typography sx={{ mt: 0.3, fontSize: 9.5, color: "text.secondary" }}>
                  Zoom {TRAFFIC_MIN_ZOOM}+
                </Typography>
              ) : null}
            </Box>
          </ButtonBase>
        );
      })}

      <ButtonBase
        onClick={handleOpen}
        aria-label="Open advanced layer menu"
        sx={{
          width: 64,
          minWidth: 64,
          borderRadius: "10px",
          border: "1px solid rgba(60,64,67,0.2)",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          gap: 0.35,
          color: "text.secondary",
        }}
      >
        <LayersIcon sx={{ fontSize: 19 }} />
        <Typography sx={{ fontSize: 11.5, lineHeight: 1, fontWeight: 500 }}>More</Typography>
      </ButtonBase>
    </Paper>
  );

  return (
    <>
      <Box
        ref={desktopAnchorRef}
        sx={{
          position: "absolute",
          bottom: 14,
          left: 12,
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
                aria-label="Open layers"
                aria-expanded={desktopExpanded ? "true" : "false"}
                sx={{ borderRadius: "14px", display: "block" }}
              >
                <Paper
                  elevation={4}
                  sx={{
                    width: 74,
                    p: 0.65,
                    borderRadius: "14px",
                    display: "flex",
                    flexDirection: "column",
                    gap: 0.6,
                  }}
                >
                  <Box
                    sx={{
                      width: "100%",
                      height: 44,
                      borderRadius: "8px",
                      background: activeBaseOption.preview,
                    }}
                  />
                  <Box
                    sx={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      gap: 0.4,
                    }}
                  >
                    <LayersIcon sx={{ fontSize: 15, color: "text.secondary" }} />
                    <Typography sx={{ fontSize: 11.5, lineHeight: 1, fontWeight: 600 }}>
                      Layers
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
              {quickSelector}
            </Box>
          </Box>
        ) : (
          <Tooltip title="Layers" placement="right">
            <Paper elevation={3} sx={{ borderRadius: "12px", overflow: "hidden" }}>
              <IconButton
                onClick={handleOpen}
                aria-label="Open map layer menu"
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
              width: desktopDock ? "min(420px, calc(100vw - 24px))" : 346,
              maxHeight: desktopDock ? "min(76vh, 700px)" : "none",
              boxShadow: "0 10px 32px rgba(60,64,67,0.3)",
              bgcolor: desktopDock ? "#f1f3f4" : "background.paper",
              overflowY: desktopDock ? "auto" : "visible",
            },
          },
        }}
      >
        {desktopDock ? (
          <Box
            sx={{
              p: 1.4,
              pointerEvents: "none",
              fontFamily: '"Google Sans", "Roboto", "Arial", sans-serif',
            }}
          >
            <Box
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                mb: 0.9,
              }}
            >
              <Typography sx={{ fontSize: 18, fontWeight: 700, color: "#202124", lineHeight: 1 }}>
                Kartendetails
              </Typography>
              <IconButton
                onClick={handleClose}
                aria-label="Close more panel placeholder"
                sx={{ pointerEvents: "auto", color: "#202124", mt: -0.5 }}
              >
                <CloseIcon sx={{ fontSize: 23 }} />
              </IconButton>
            </Box>

            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(3, minmax(0,1fr))",
                justifyItems: "start",
                columnGap: 0.9,
                rowGap: 0.9,
              }}
            >
              {DESKTOP_MORE_MAP_DETAILS.map((item) => (
                <DesktopMoreTile key={item.id} item={item} labelWidth={96} />
              ))}
            </Box>

            <Divider sx={{ my: 0.95, borderColor: "rgba(60,64,67,0.2)" }} />

            <Typography
              sx={{ fontSize: 17, fontWeight: 700, color: "#202124", lineHeight: 1, mb: 0.8 }}
            >
              Kartentools
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0,1fr))",
                justifyItems: "start",
                columnGap: 0.9,
                rowGap: 0.9,
              }}
            >
              {DESKTOP_MORE_MAP_TOOLS.map((item) => (
                <DesktopMoreTile key={item.id} item={item} labelWidth={96} />
              ))}
            </Box>

            <Divider sx={{ my: 0.95, borderColor: "rgba(60,64,67,0.2)" }} />

            <Typography
              sx={{ fontSize: 17, fontWeight: 700, color: "#202124", lineHeight: 1, mb: 0.8 }}
            >
              Kartentyp
            </Typography>
            <Box
              sx={{
                display: "grid",
                gridTemplateColumns: "repeat(2, minmax(0,1fr))",
                justifyItems: "start",
                columnGap: 0.9,
                rowGap: 0.9,
              }}
            >
              {DESKTOP_MORE_MAP_TYPES.map((item) => (
                <DesktopMoreTile key={item.id} item={item} labelWidth={96} />
              ))}
            </Box>

            <Box sx={{ mt: 0.2, display: "flex", alignItems: "center", gap: 1.1 }}>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.2 }}>
                <CheckBoxOutlineBlankIcon sx={{ fontSize: 19, color: "#202124" }} />
                <Typography sx={{ fontSize: 12.5, color: "#202124" }}>Globusansicht</Typography>
                <HelpOutlineIcon sx={{ fontSize: 14, color: "#3c4043" }} />
              </Box>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.2 }}>
                <CheckBoxIcon sx={{ fontSize: 19, color: "#0b7d8b" }} />
                <Typography sx={{ fontSize: 12.5, color: "#202124" }}>Labels</Typography>
              </Box>
            </Box>
          </Box>
        ) : (
          <Box sx={{ p: 1.5 }}>
            <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 1 }}>
              Map type
            </Typography>

            <Box sx={{ display: "flex", gap: 1 }}>
              {BASE_LAYER_OPTIONS.map((option) => {
                const selected = option.id === activeLayer;
                return (
                  <ButtonBase
                    key={option.id}
                    onClick={() => setActiveLayer(option.id)}
                    aria-label={`Use ${option.label} map`}
                    sx={{
                      width: 95,
                      borderRadius: "12px",
                      p: 0.75,
                      textAlign: "left",
                      border: selected ? "2px solid #1A73E8" : "1px solid rgba(60,64,67,0.2)",
                      transition: "border-color 0.15s, box-shadow 0.15s",
                      boxShadow: selected ? "0 0 0 1px rgba(26,115,232,0.2)" : "none",
                    }}
                  >
                    <Box sx={{ width: "100%" }}>
                      <Box
                        sx={{
                          width: "100%",
                          height: 56,
                          borderRadius: "8px",
                          background: option.preview,
                          mb: 0.6,
                        }}
                      />
                      <Box sx={{ display: "flex", alignItems: "center", gap: 0.4 }}>
                        <Box sx={{ display: "flex", color: "text.secondary" }}>{option.icon}</Box>
                        <Typography
                          sx={{
                            fontSize: 12,
                            lineHeight: 1.1,
                            fontWeight: selected ? 600 : 500,
                            color: selected ? "text.primary" : "text.secondary",
                          }}
                        >
                          {option.label}
                        </Typography>
                      </Box>
                    </Box>
                  </ButtonBase>
                );
              })}
            </Box>

            <Divider sx={{ my: 1.5 }} />

            <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 0.5 }}>
              Map details
            </Typography>

            <FormControlLabel
              sx={{ mr: 0, ml: 0.25 }}
              label={
                <Box
                  sx={{
                    display: "flex",
                    alignItems: "center",
                    gap: 0.8,
                    opacity: trafficZoomTooLow ? 0.5 : 1,
                  }}
                >
                  <TrafficIcon sx={{ fontSize: 17, color: "text.secondary" }} />
                  <Typography sx={{ fontSize: 13.5 }}>Traffic</Typography>
                </Box>
              }
              control={
                <Switch
                  checked={showTraffic}
                  onChange={(event) => setShowTraffic(event.target.checked)}
                  inputProps={{ "aria-label": "Toggle traffic overlay" }}
                  size="small"
                  disabled={trafficZoomTooLow}
                />
              }
            />

            <FormControlLabel
              sx={{ mr: 0, ml: 0.25 }}
              label={
                <Box sx={{ display: "flex", alignItems: "center", gap: 0.8 }}>
                  <DirectionsTransitFilledIcon sx={{ fontSize: 17, color: "text.secondary" }} />
                  <Typography sx={{ fontSize: 13.5 }}>Transit</Typography>
                </Box>
              }
              control={
                <Switch
                  checked={showTransit}
                  onChange={(event) => setShowTransit(event.target.checked)}
                  inputProps={{ "aria-label": "Toggle transit overlay" }}
                  size="small"
                />
              }
            />

            <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.5 }}>
              Traffic uses live TomTom flow tiles via the OpenMapX API gateway.
            </Typography>
            {trafficZoomTooLow ? (
              <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.35 }}>
                Zoom in to level {TRAFFIC_MIN_ZOOM}+ to enable traffic.
              </Typography>
            ) : null}
          </Box>
        )}
      </Popover>
    </>
  );
}
