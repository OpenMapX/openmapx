"use client";

import AcUnitIcon from "@mui/icons-material/AcUnit";
import AirIcon from "@mui/icons-material/Air";
import DirectionsTransitFilledIcon from "@mui/icons-material/DirectionsTransitFilled";
import HikingIcon from "@mui/icons-material/Hiking";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import PublicIcon from "@mui/icons-material/Public";
import StreetviewIcon from "@mui/icons-material/Streetview";
import TrafficIcon from "@mui/icons-material/Traffic";
import Box from "@mui/material/Box";
import ButtonBase from "@mui/material/ButtonBase";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import type { OverlayId } from "@openmapx/core";
import { OVERLAY_REGISTRY, toggleOverlay, useLayerStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import type { ReactNode } from "react";
import { TRAFFIC_MIN_ZOOM } from "../layers/trafficConfig";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";

interface MobileLayerPanelProps {
  trafficZoomTooLow: boolean;
}

const OVERLAY_SWITCHES: { id: OverlayId; labelKey: string; icon: ReactNode }[] = [
  {
    id: "cycling",
    labelKey: "cycling",
    icon: <PedalBikeIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "street-view",
    labelKey: "streetLevelImagery",
    icon: <StreetviewIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "air-quality",
    labelKey: "airQuality",
    icon: <AirIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "winter-sports",
    labelKey: "winterSports",
    icon: <AcUnitIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "hiking",
    labelKey: "hiking",
    icon: <HikingIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "earthquakes",
    labelKey: "earthquakes",
    icon: <PublicIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
];

function OverlaySwitchRow({ entry }: { entry: (typeof OVERLAY_SWITCHES)[number] }) {
  const t = useTranslations("layers");
  const registryEntry = OVERLAY_REGISTRY.find((r) => r.id === entry.id);
  const active = registryEntry?.useActive() ?? false;

  return (
    <FormControlLabel
      sx={{ mr: 0, ml: 0.25 }}
      label={
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.8 }}>
          {entry.icon}
          <Typography sx={{ fontSize: 13.5 }}>{t(entry.labelKey)}</Typography>
        </Box>
      }
      control={
        <Switch
          checked={active}
          onChange={() => toggleOverlay(entry.id)}
          inputProps={{ "aria-label": t("toggleOverlay", { layer: t(entry.labelKey) }) }}
          size="small"
        />
      }
    />
  );
}

export function MobileLayerPanel({ trafficZoomTooLow }: MobileLayerPanelProps) {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);
  const showTraffic = useLayerStore((s) => s.showTraffic);
  const setShowTraffic = useLayerStore((s) => s.setShowTraffic);
  const showTransit = useLayerStore((s) => s.showTransit);
  const setShowTransit = useLayerStore((s) => s.setShowTransit);

  return (
    <Box sx={{ p: 1.5 }}>
      <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 1 }}>
        {t("mapType")}
      </Typography>

      <Box sx={{ display: "flex", gap: 1 }}>
        {BASE_LAYER_OPTIONS.map((option) => {
          const selected = option.id === activeLayer;
          const label = t(option.labelKey);
          return (
            <ButtonBase
              key={option.id}
              onClick={() => setActiveLayer(option.id)}
              aria-label={t("useMap", { layer: label })}
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
                    overflow: "hidden",
                    mb: 0.6,
                  }}
                >
                  {option.preview}
                </Box>
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
                    {label}
                  </Typography>
                </Box>
              </Box>
            </ButtonBase>
          );
        })}
      </Box>

      <Divider sx={{ my: 1.5 }} />

      <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 0.5 }}>
        {t("mapDetails")}
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
            <Typography sx={{ fontSize: 13.5 }}>{t("traffic")}</Typography>
          </Box>
        }
        control={
          <Switch
            checked={showTraffic}
            onChange={(event) => setShowTraffic(event.target.checked)}
            inputProps={{ "aria-label": t("toggleTrafficOverlay") }}
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
            <Typography sx={{ fontSize: 13.5 }}>{t("transit")}</Typography>
          </Box>
        }
        control={
          <Switch
            checked={showTransit}
            onChange={(event) => setShowTransit(event.target.checked)}
            inputProps={{ "aria-label": t("toggleTransitOverlay") }}
            size="small"
          />
        }
      />

      {OVERLAY_SWITCHES.map((entry) => (
        <OverlaySwitchRow key={entry.id} entry={entry} />
      ))}

      <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.5 }}>
        {t("trafficNote")}
      </Typography>
      {trafficZoomTooLow ? (
        <Typography sx={{ fontSize: 11.5, color: "text.secondary", mt: 0.35 }}>
          {t("zoomForTraffic", { zoom: TRAFFIC_MIN_ZOOM })}
        </Typography>
      ) : null}
    </Box>
  );
}
