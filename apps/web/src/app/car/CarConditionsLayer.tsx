"use client";
import { roadConditionAttributions } from "@integrations/road-conditions/attributions";
import {
  buildRoadConditionDisplayGroups,
  buildRoadConditionFeatures,
} from "@integrations/road-conditions/display";
import { incidentLayerGroup } from "@integrations/road-conditions/incident-layers";
import { markerImageData, parseMarkerImageId } from "@integrations/road-conditions/markers";
import { fetchRoadConditionsWithStatus, type RoadConditionEvent } from "@openmapx/core";
import { useLocale } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { useMap } from "@/integration-api/map/MapContext";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";

const ids = {
  source: "car-conditions",
  line: "car-conditions-lines",
  marker: "car-conditions-markers",
};
export function CarConditionsLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const locale = useLocale();
  const [events, setEvents] = useState<RoadConditionEvent[]>([]);
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;
    let controller: AbortController | undefined;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () => {
      if (map.getZoom() < 8) {
        setEvents([]);
        return;
      }
      controller?.abort();
      controller = new AbortController();
      const b = map.getBounds();
      void fetchRoadConditionsWithStatus([b.getWest(), b.getSouth(), b.getEast(), b.getNorth()], {
        signal: controller.signal,
      })
        .then((result) => {
          if (!disposed && result.ok) setEvents(result.events);
        })
        .catch(() => {});
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(load, 500);
    };
    load();
    map.on("moveend", schedule);
    const interval = setInterval(load, 120000);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      clearInterval(interval);
      map.off("moveend", schedule);
    };
  }, [mapRef, mapReady]);
  const group = useMemo(() => {
    const descriptor = incidentLayerGroup(ids, {
      zoom: { minzoom: 8 },
      order: 10,
      lineWidth: 6,
      iconSize: 1.2,
    });
    return {
      ...descriptor,
      sources: {
        [ids.source]: {
          type: "geojson" as const,
          data: {
            type: "FeatureCollection" as const,
            features: buildRoadConditionFeatures(
              buildRoadConditionDisplayGroups(events),
              locale,
              Date.now(),
              roadConditionAttributions,
            ),
          },
        },
      },
    };
  }, [events, locale]);
  useMapLayerGroup(group);
  useRenderedMapAttributions("car-conditions", [ids.line, ids.marker], true);
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    map.setMissingStyleImageResolver((id) => {
      const parsed = parseMarkerImageId(id);
      if (!parsed || map.hasImage(id)) return;
      const image = markerImageData(parsed.glyph, parsed.severity);
      if (image) map.addImage(id, image, { pixelRatio: 2 });
    });
    return () => {
      map.setMissingStyleImageResolver(null);
    };
  }, [mapRef, mapReady, styleVersion]);
  return null;
}
