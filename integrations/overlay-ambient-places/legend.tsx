"use client";
import Typography from "@mui/material/Typography";
import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
import { useAmbientPlacesStore } from "./store";
export function AmbientPlacesLegend() {
  const t = useTranslations("ambientPlaces");
  const locale = useLocale();
  const state = useAmbientPlacesStore();
  const setVisible = useOverlayVisibilitySetter("ambient-places");
  if (!state.manifest && state.userRevision === 0) return null;
  return (
    <OverlayLegend
      title={t("title")}
      panelOpen={state.panelOpen}
      layerVisible={state.layerVisible}
      loading={state.loading}
      setLayerVisible={setVisible}
      toggleAriaLabel={t("toggle")}
      paperSx={{ maxWidth: 300 }}
    >
      <Typography variant="body2">
        {state.manifest ? state.manifest.region.name : t("unavailable")}
      </Typography>
      {state.manifest && (
        <Typography variant="caption" color="text.secondary">
          {t("snapshot", { date: new Date(state.manifest.publishedAt).toLocaleDateString(locale) })}{" "}
          · {state.manifest.sources.overture ? t("combined") : t("osmOnly")}
        </Typography>
      )}
      {state.manifest && !state.manifest.enabled && (
        <Typography variant="caption">{t("disabled")}</Typography>
      )}
      {state.error && <Typography variant="caption">{t("error")}</Typography>}
    </OverlayLegend>
  );
}
