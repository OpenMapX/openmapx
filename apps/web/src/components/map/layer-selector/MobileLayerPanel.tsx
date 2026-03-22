"use client";

import AcUnitIcon from "@mui/icons-material/AcUnit";
import AirIcon from "@mui/icons-material/Air";
import DirectionsTransitFilledIcon from "@mui/icons-material/DirectionsTransitFilled";
import HikingIcon from "@mui/icons-material/Hiking";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import PedalBikeIcon from "@mui/icons-material/PedalBike";
import PublicIcon from "@mui/icons-material/Public";
import StreetviewIcon from "@mui/icons-material/Streetview";
import TrafficIcon from "@mui/icons-material/Traffic";
import TrainIcon from "@mui/icons-material/Train";
import ViewInArIcon from "@mui/icons-material/ViewInAr";
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

import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";

const OVERLAY_SWITCHES: { id: OverlayId; labelKey: string; icon: ReactNode }[] = [
  {
    id: "traffic",
    labelKey: "traffic",
    icon: <TrafficIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "transit",
    labelKey: "transit",
    icon: <DirectionsTransitFilledIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "live-trains",
    labelKey: "liveTrains",
    icon: <TrainIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "cycling",
    labelKey: "cycling",
    icon: <PedalBikeIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  // Kartenansichten
  {
    id: "street-view",
    labelKey: "streetLevelImagery",
    icon: <StreetviewIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "3d-buildings",
    labelKey: "3dBuildings",
    icon: <ViewInArIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  // Outdoor & Freizeit
  {
    id: "hiking",
    labelKey: "hiking",
    icon: <HikingIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "winter-sports",
    labelKey: "winterSports",
    icon: <AcUnitIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  // Umwelt & Gefahren
  {
    id: "air-quality",
    labelKey: "airQuality",
    icon: <AirIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
  },
  {
    id: "wildfires",
    labelKey: "wildfires",
    icon: <LocalFireDepartmentIcon sx={{ fontSize: 17, color: "text.secondary" }} />,
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

function GlobeSwitchRow() {
  const t = useTranslations("layers");
  const globeView = useLayerStore((s) => s.globeView);
  const setGlobeView = useLayerStore((s) => s.setGlobeView);

  return (
    <FormControlLabel
      sx={{ mr: 0, ml: 0.25 }}
      label={
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.8 }}>
          <PublicIcon sx={{ fontSize: 17, color: "text.secondary" }} />
          <Typography sx={{ fontSize: 13.5 }}>{t("globeView")}</Typography>
        </Box>
      }
      control={
        <Switch
          checked={globeView}
          onChange={(e) => setGlobeView(e.target.checked)}
          inputProps={{ "aria-label": t("globeView") }}
          size="small"
        />
      }
    />
  );
}

export function MobileLayerPanel() {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);

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

      {OVERLAY_SWITCHES.map((entry) => (
        <OverlaySwitchRow key={entry.id} entry={entry} />
      ))}
      <GlobeSwitchRow />
    </Box>
  );
}
