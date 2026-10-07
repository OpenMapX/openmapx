"use client";

import { useOverlayVisibilitySetter } from "@openmapx/core";
import { useTranslations } from "next-intl";
import { OverlayLegend } from "@/integration-api/overlay/OverlayLegend";
import { TrafficOverlayContext } from "@/integration-api/overlay/TrafficOverlayContext";
import { useTrafficStore } from "./store";

export function TrafficLegend() {
  const t = useTranslations("trafficStatus.overlay");
  const tm = useTranslations("layers");
  const panelOpen = useTrafficStore((s) => s.panelOpen);
  const layerVisible = useTrafficStore((s) => s.layerVisible);
  const setLayerVisible = useOverlayVisibilitySetter("traffic");
  return (
    <OverlayLegend
      title={tm("trafficTomtom")}
      panelOpen={panelOpen}
      layerVisible={layerVisible}
      loading={false}
      setLayerVisible={setLayerVisible}
      toggleAriaLabel={t("toggleHosted")}
      paperSx={{ maxWidth: { xs: "90vw", sm: 340 }, minWidth: 240 }}
    >
      <TrafficOverlayContext hosted visible={layerVisible} />
    </OverlayLegend>
  );
}
