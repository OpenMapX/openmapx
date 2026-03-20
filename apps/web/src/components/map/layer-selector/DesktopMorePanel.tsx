"use client";

import CheckBoxIcon from "@mui/icons-material/CheckBox";
import CheckBoxOutlineBlankIcon from "@mui/icons-material/CheckBoxOutlineBlank";
import CloseIcon from "@mui/icons-material/Close";
import HelpOutlineIcon from "@mui/icons-material/HelpOutline";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import IconButton from "@mui/material/IconButton";
import Typography from "@mui/material/Typography";
import type { MapLayer } from "@openmapx/core";
import { OVERLAY_REGISTRY, toggleOverlay, useLayerStore } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { DesktopMoreTile } from "./DesktopMoreTile";
import {
  DESKTOP_MORE_MAP_DETAILS,
  DESKTOP_MORE_MAP_TOOLS,
  DESKTOP_MORE_MAP_TYPES,
} from "./layerSelectorConfig";

interface DesktopMorePanelProps {
  onClose: () => void;
}

function OverlayDetailTile({
  item,
  label,
  onClose,
}: {
  item: (typeof DESKTOP_MORE_MAP_DETAILS)[number];
  label: string;
  onClose: () => void;
}) {
  const entry = item.overlayId ? OVERLAY_REGISTRY.find((r) => r.id === item.overlayId) : undefined;
  const active = entry?.useActive() ?? item.selected ?? false;

  return (
    <DesktopMoreTile
      item={{ ...item, selected: active }}
      label={label}
      labelWidth={96}
      onClick={
        item.overlayId
          ? () => {
              if (item.overlayId) toggleOverlay(item.overlayId);
              onClose();
            }
          : undefined
      }
    />
  );
}

export function DesktopMorePanel({ onClose }: DesktopMorePanelProps) {
  const t = useTranslations("layers");
  const activeLayer = useLayerStore((s) => s.activeLayer);
  const setActiveLayer = useLayerStore((s) => s.setActiveLayer);

  return (
    <Box
      sx={{
        px: 1.5,
        py: 1.2,
        fontFamily: '"Google Sans", "Roboto", "Arial", sans-serif',
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
        <Typography sx={{ fontSize: 18, fontWeight: 700, color: "#202124", lineHeight: 1 }}>
          {t("mapDetails")}
        </Typography>
        <IconButton
          onClick={onClose}
          aria-label={t("closeMorePanel")}
          sx={{ color: "#202124", mt: -0.5 }}
        >
          <CloseIcon sx={{ fontSize: 23 }} />
        </IconButton>
      </Box>

      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(3, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {DESKTOP_MORE_MAP_DETAILS.map((item) => (
          <OverlayDetailTile key={item.id} item={item} label={t(item.labelKey)} onClose={onClose} />
        ))}
      </Box>

      <Divider sx={{ my: 0.8, borderColor: "rgba(60,64,67,0.12)" }} />

      <Typography sx={{ fontSize: 16, fontWeight: 700, color: "#202124", lineHeight: 1, mb: 0.6 }}>
        {t("mapTools")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {DESKTOP_MORE_MAP_TOOLS.map((item) => (
          <DesktopMoreTile key={item.id} item={item} label={t(item.labelKey)} labelWidth={96} />
        ))}
      </Box>

      <Divider sx={{ my: 0.8, borderColor: "rgba(60,64,67,0.12)" }} />

      <Typography sx={{ fontSize: 16, fontWeight: 700, color: "#202124", lineHeight: 1, mb: 0.6 }}>
        {t("mapType")}
      </Typography>
      <Box
        sx={{
          display: "grid",
          gridTemplateColumns: "repeat(2, minmax(0,1fr))",
          justifyItems: "center",
          columnGap: 0.5,
          rowGap: 0.4,
        }}
      >
        {DESKTOP_MORE_MAP_TYPES.map((item) => (
          <DesktopMoreTile
            key={item.id}
            item={{ ...item, selected: item.id === activeLayer }}
            label={t(item.labelKey)}
            labelWidth={96}
            onClick={() => {
              setActiveLayer(item.id as MapLayer);
              onClose();
            }}
          />
        ))}
      </Box>

      <Box sx={{ mt: 0.2, display: "flex", alignItems: "center", gap: 1.1 }}>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.2 }}>
          <CheckBoxOutlineBlankIcon sx={{ fontSize: 19, color: "#202124" }} />
          <Typography sx={{ fontSize: 12.5, color: "#202124" }}>{t("globeView")}</Typography>
          <HelpOutlineIcon sx={{ fontSize: 14, color: "#3c4043" }} />
        </Box>
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.2 }}>
          <CheckBoxIcon sx={{ fontSize: 19, color: "#0b7d8b" }} />
          <Typography sx={{ fontSize: 12.5, color: "#202124" }}>{t("labels")}</Typography>
        </Box>
      </Box>
    </Box>
  );
}
