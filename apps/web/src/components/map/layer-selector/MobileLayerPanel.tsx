"use client";

import PublicIcon from "@mui/icons-material/Public";
import Box from "@mui/material/Box";
import Divider from "@mui/material/Divider";
import FormControlLabel from "@mui/material/FormControlLabel";
import Switch from "@mui/material/Switch";
import Typography from "@mui/material/Typography";
import {
  toggleOverlay,
  useCapabilities,
  useIntegrationOverlayActive,
  useLayerStore,
} from "@openmapx/core";
import { useTranslations } from "next-intl";

import { LayerPreviewTile } from "./LayerPreviewTile";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

function OverlaySwitchRow({ entry }: { entry: GeneratedLayerEntry }) {
  const t = useTranslations("layers");
  const active = useIntegrationOverlayActive(entry.overlayId);

  return (
    <FormControlLabel
      sx={{ mr: 0, ml: 0.25 }}
      label={
        <Box sx={{ display: "flex", alignItems: "center", gap: 0.8 }}>
          <Box
            sx={{
              color: "text.secondary",
              display: "flex",
              "& .MuiIcon-root": { fontSize: 17 },
              "& .MuiSvgIcon-root": { fontSize: 17 },
            }}
          >
            {entry.icon}
          </Box>
          <Typography sx={{ fontSize: 13.5 }}>{t(entry.labelKey)}</Typography>
        </Box>
      }
      control={
        <Switch
          checked={active}
          onChange={() => toggleOverlay(entry.overlayId)}
          slotProps={{ input: { "aria-label": t("toggleOverlay", { layer: t(entry.labelKey) }) } }}
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
          slotProps={{ input: { "aria-label": t("globeView") } }}
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
  const { isAvailable } = useCapabilities();
  const { mapDetails } = useLayerSelectorConfig();

  return (
    <Box sx={{ p: 1.5 }}>
      <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 1 }}>
        {t("mapType")}
      </Typography>

      <Box sx={{ display: "flex", gap: 1.5, justifyContent: "center" }}>
        {BASE_LAYER_OPTIONS.map((option) => {
          const selected = option.id === activeLayer;
          return (
            <LayerPreviewTile
              key={option.id}
              preview={option.preview}
              label={t(option.labelKey)}
              selected={selected}
              icon={option.icon}
              size={56}
              onClick={() => setActiveLayer(option.id)}
            />
          );
        })}
      </Box>

      <Divider sx={{ my: 1.5 }} />

      <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 0.5 }}>
        {t("mapDetails")}
      </Typography>

      {mapDetails
        .filter((entry) => isAvailable(entry.serviceId))
        .map((entry) => (
          <OverlaySwitchRow key={entry.id} entry={entry} />
        ))}
      <GlobeSwitchRow />
    </Box>
  );
}
