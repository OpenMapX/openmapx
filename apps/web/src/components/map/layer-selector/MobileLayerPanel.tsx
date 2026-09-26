"use client";

import { useMeasurementStore } from "@integrations/overlay-tool-measurement/store";
import { useTravelTimeStore } from "@integrations/overlay-tool-travel-time/store";
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

import { useOverlayZoomGate } from "@/integration-api/overlay/overlayZoomGate";
import { LayerPreviewTile } from "./LayerPreviewTile";
import { BASE_LAYER_OPTIONS } from "./layerSelectorConfig";
import type { GeneratedLayerEntry } from "./useLayerSelectorConfig";
import { useLayerSelectorConfig } from "./useLayerSelectorConfig";

function OverlaySwitchRow({ entry }: { entry: GeneratedLayerEntry }) {
  const t = useTranslations("layers");
  const active = useIntegrationOverlayActive(entry.overlayId);
  // Overlays declare a minimum usable zoom in their manifest; below it the row
  // is disabled and says so rather than toggling on something that would
  // render nothing.
  const { minZoom, belowMinZoom } = useOverlayZoomGate(entry.overlayId);

  return (
    <FormControlLabel
      sx={{ mr: 0, ml: 0.25 }}
      disabled={belowMinZoom}
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
          <Box>
            <Typography sx={{ fontSize: 13.5 }}>{t(entry.labelKey)}</Typography>
            {entry.descriptionKey && !belowMinZoom ? (
              <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
                {t(entry.descriptionKey)}
              </Typography>
            ) : null}
          </Box>
          {belowMinZoom ? (
            <Typography sx={{ fontSize: 11, color: "text.secondary" }}>
              {t("zoomInHint", { minZoom })}
            </Typography>
          ) : null}
        </Box>
      }
      control={
        <Switch
          checked={active && !belowMinZoom}
          onChange={() => {
            if (!belowMinZoom) toggleOverlay(entry.overlayId, { kind: "user" });
          }}
          slotProps={{ input: { "aria-label": t("toggleOverlay", { layer: t(entry.labelKey) }) } }}
          size="small"
        />
      }
    />
  );
}

function ToolSwitchRow({
  entry,
  active,
  onToggle,
}: {
  entry: GeneratedLayerEntry;
  active: boolean;
  onToggle: () => void;
}) {
  const t = useTranslations("layers");
  return (
    <FormControlLabel
      sx={{ mr: 0, ml: 0.25 }}
      label={<Typography sx={{ fontSize: 13.5 }}>{t(entry.labelKey)}</Typography>}
      control={
        <Switch
          checked={active}
          onChange={onToggle}
          size="small"
          slotProps={{ input: { "aria-label": t(entry.labelKey) } }}
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
  const { detailGroups, mapTools } = useLayerSelectorConfig();
  const measureActive = useMeasurementStore((s) => s.isActive);
  const travelTimeActive = useTravelTimeStore((s) => s.isActive);

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

      {detailGroups.map((group) => {
        const entries = group.entries.filter((entry) => isAvailable(entry.serviceId));
        if (entries.length === 0) return null;
        return (
          <Box key={group.id} sx={{ mb: 1 }}>
            <Typography sx={{ fontSize: 12, color: "text.secondary", fontWeight: 600, mb: 0.25 }}>
              {t(group.id)}
            </Typography>
            {entries.map((entry) => (
              <OverlaySwitchRow key={entry.id} entry={entry} />
            ))}
          </Box>
        );
      })}

      <Divider sx={{ my: 1.5 }} />
      <Typography sx={{ fontSize: 13, color: "text.secondary", fontWeight: 600, mb: 0.5 }}>
        {t("mapTools")}
      </Typography>
      {mapTools.map((entry) => {
        const tool =
          entry.id === "measurement"
            ? { active: measureActive, store: useMeasurementStore }
            : entry.id === "travel-time"
              ? { active: travelTimeActive, store: useTravelTimeStore }
              : null;
        if (!tool) return null;
        return (
          <ToolSwitchRow
            key={entry.id}
            entry={entry}
            active={tool.active}
            onToggle={() => {
              const state = tool.store.getState();
              if (state.isActive) state.deactivate();
              else state.activate();
            }}
          />
        );
      })}
      <GlobeSwitchRow />
    </Box>
  );
}
