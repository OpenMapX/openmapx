"use client";

import { dataSourceToAttribution } from "@openmapx/integration-framework";
import { useIntegrationRegistry } from "@openmapx/integration-framework/react";
import { snapshotContributors } from "@openmapx/mobility-core/contributors";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { useOfflinePackageActive } from "@/integration-api/map/offlinePackage";
import { useSceneLight } from "@/integration-api/map/sceneLight";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { useMapDetailsActive } from "./activation";
import { useMapDetailsObjects } from "./objects";
import { applyBasemapAdjustments, type BasemapRestore } from "./web/basemap-adjustments";
import { ensurePaintProtocol, PAINT_SOURCE_ID, PAINT_TEMPLATE } from "./web/paint-protocol";
import {
  type ColourScheme,
  PAINT_LAYER_ID,
  paintColour,
  paintLayerSpec,
  paintOpacity,
} from "./web/paint-style";
import {
  absoluteTemplate,
  createMapDetailsWorker,
  type MapDetailsWorkerClient,
} from "./web/worker-client";

/** Above basemap roads, below the building extrusions (order 5) and every other area overlay. */
const PAINT_SLOT_ORDER = 0;
const DATA_SOURCE_ID = "osm-street-detail";

/**
 * Forests, street objects and street paint in the 3D view (spec §6). The
 * worker and the street detail source are set up on first activation; the
 * paint source then stays and is only hidden while inactive.
 */
export function MapDetailsLayer(): null {
  const { mapRef, mapReady } = useMap();
  const map = mapReady ? mapRef.current : null;
  const { streetDetailTilesUrl } = useEnv();
  const offline = useOfflinePackageActive();
  const { active, pitchFade, satellite } = useMapDetailsActive(map);
  const night = useSceneLight((light) => light.night);
  const scheme: ColourScheme = night ? "dark" : "light";
  const [client, setClient] = useState<MapDetailsWorkerClient | null>(null);
  const [template, setTemplate] = useState<string | null>(null);
  const tileJson = useRef<"idle" | "loading" | "done" | "failed">("idle");
  const wantsStreetDetail = streetDetailTilesUrl !== "" && !offline;
  const hasSource = wantsStreetDetail && template !== null;
  const paintVisible = active && !satellite;
  const live = useRef({ scheme, pitchFade, paintVisible, template, client });
  live.current = { scheme, pitchFade, paintVisible, template, client };

  // One worker for all derivation, from the first activation until unmount.
  useEffect(() => {
    if (active && !client) setClient(createMapDetailsWorker());
  }, [active, client]);
  useEffect(() => () => client?.dispose(), [client]);

  // The street detail TileJSON, fetched once; a failure means no street detail (forests still plant).
  useEffect(() => {
    if (!active || !wantsStreetDetail || tileJson.current !== "idle") return;
    tileJson.current = "loading";
    const url = new URL(streetDetailTilesUrl, document.baseURI).href;
    let cancelled = false;
    void fetch(url)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Street detail TileJSON answered ${response.status}`);
        const tiles = ((await response.json()) as { tiles?: unknown }).tiles;
        const first = Array.isArray(tiles) ? tiles[0] : undefined;
        if (typeof first !== "string") throw new Error("Street detail TileJSON has no tiles");
        if (cancelled) return;
        tileJson.current = "done";
        setTemplate(absoluteTemplate(first, url));
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        tileJson.current = "failed";
        console.warn("Street detail is unavailable", error);
      });
    return () => {
      cancelled = true;
      if (tileJson.current === "loading") tileJson.current = "idle";
    };
  }, [active, wantsStreetDetail, streetDetailTilesUrl]);

  // The paint source and layer, kept across style swaps.
  useEffect(() => {
    if (!map || !hasSource) return;
    ensurePaintProtocol(
      () => live.current.client,
      () => live.current.template,
    );
    const unsubscribe = subscribeStyleLoaded(map, () => {
      if (!map.getSource(PAINT_SOURCE_ID))
        map.addSource(PAINT_SOURCE_ID, {
          type: "vector",
          tiles: [PAINT_TEMPLATE],
          minzoom: 16,
          maxzoom: 18,
        });
      if (!map.getLayer(PAINT_LAYER_ID)) {
        const { scheme: currentScheme, pitchFade: fade, paintVisible: visible } = live.current;
        const spec = paintLayerSpec(currentScheme);
        addLayerInSlot(
          map,
          {
            ...spec,
            layout: { ...spec.layout, visibility: visible ? "visible" : "none" },
            paint: { ...spec.paint, "fill-opacity": paintOpacity(fade) },
          },
          "area-overlays",
          PAINT_SLOT_ORDER,
        );
      }
    });
    return () => {
      unsubscribe();
      if (map.getLayer(PAINT_LAYER_ID)) map.removeLayer(PAINT_LAYER_ID);
      if (map.getSource(PAINT_SOURCE_ID)) map.removeSource(PAINT_SOURCE_ID);
    };
  }, [map, hasSource]);

  // A layer added later reads the current values from `live` when it is added.
  useEffect(() => {
    if (map?.getLayer(PAINT_LAYER_ID))
      map.setLayoutProperty(PAINT_LAYER_ID, "visibility", paintVisible ? "visible" : "none");
  }, [map, paintVisible]);

  useEffect(() => {
    if (map?.getLayer(PAINT_LAYER_ID))
      map.setPaintProperty(PAINT_LAYER_ID, "fill-opacity", paintOpacity(pitchFade));
  }, [map, pitchFade]);

  useEffect(() => {
    if (map?.getLayer(PAINT_LAYER_ID))
      map.setPaintProperty(PAINT_LAYER_ID, "fill-color", paintColour(scheme));
  }, [map, scheme]);

  // Deeper woods and faded one-way arrows while active, restored afterwards.
  useEffect(() => {
    if (!map || !active) return;
    let restore: BasemapRestore | null = null;
    const unsubscribe = subscribeStyleLoaded(map, () => {
      if (restore?.isCurrent()) return;
      restore = applyBasemapAdjustments(map, scheme, hasSource);
    });
    return () => {
      unsubscribe();
      restore?.();
    };
  }, [map, active, scheme, hasSource]);

  const registry = useIntegrationRegistry();
  const contributors = useMemo(() => {
    const source = registry.findDataSource(DATA_SOURCE_ID);
    return snapshotContributors(source ? [dataSourceToAttribution(source)] : []);
  }, [registry]);
  const attribution = useMemo(
    () => ({ layerContributors: { [PAINT_LAYER_ID]: contributors } }),
    [contributors],
  );
  useRenderedMapAttributions(
    "map-details-paint",
    [PAINT_LAYER_ID],
    paintVisible && hasSource,
    attribution,
  );

  useMapDetailsObjects({
    map,
    active,
    client,
    streetTemplate: hasSource ? template : null,
    satellite,
    contributors,
  });

  return null;
}

export default MapDetailsLayer;
