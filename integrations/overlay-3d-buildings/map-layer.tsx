"use client";

import {
  allReplacements,
  type BuildingReplacement,
  runOverlayTransaction,
  useBuildingReplacementStore,
  useNavigationStore,
  useOverlayExclusion,
} from "@openmapx/core";
import type * as maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import {
  buildingExtrusionColor,
  EXTRUSION_BASE,
  EXTRUSION_COLOR,
  EXTRUSION_HEIGHT,
  findBuildingRoofColor,
  findBuildingSourceReference,
} from "./building-style";
import manifest from "./manifest.json";
import {
  addMaskedSource,
  ensureMaskProtocol,
  isMaskable,
  type LiveBuildingSource,
  MASKED_SOURCE_ID,
  MASKED_TEMPLATE,
  readLiveBuildingSource,
} from "./masked-source";
import { BUILDING_TILT_THRESHOLD as TILT_THRESHOLD, useBuildingsStore } from "./store";

const LAYER_ID = "openmapx-3d-buildings";
const MIN_ZOOM = manifest.frontend.overlay.minZoom;
const AUTO_PITCH = 45;

function prefersReducedMotion(): boolean {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function moveToPitch(map: maplibregl.Map, pitch: number, duration: number): void {
  if (prefersReducedMotion()) {
    map.jumpTo({ pitch }, { programmatic: true });
    return;
  }
  map.easeTo({ pitch, duration }, { programmatic: true });
}

type BuildingSourceReference = NonNullable<ReturnType<typeof findBuildingSourceReference>>;

/** The one place the extrusion layer enters the stack, whichever source feeds it. */
function addExtrusionLayer(
  map: maplibregl.Map,
  basemap: BuildingSourceReference,
  source: string,
  sourceLayer: string,
): void {
  const layer = {
    id: LAYER_ID,
    type: "fill-extrusion",
    source,
    "source-layer": sourceLayer,
    minzoom: MIN_ZOOM,
    filter: ["!=", ["get", "hide_3d"], true],
    layout: {
      visibility:
        useBuildingsStore.getState().layerVisible && map.getPitch() > TILT_THRESHOLD
          ? "visible"
          : "none",
    },
    paint: {
      "fill-extrusion-color": buildingExtrusionColor(
        findBuildingRoofColor(map, basemap) ?? EXTRUSION_COLOR,
      ),
      "fill-extrusion-height": EXTRUSION_HEIGHT,
      "fill-extrusion-base": EXTRUSION_BASE,
      "fill-extrusion-opacity": [
        "interpolate",
        ["linear"],
        ["zoom"],
        MIN_ZOOM,
        0,
        MIN_ZOOM + 0.5,
        1,
      ],
      "fill-extrusion-vertical-gradient": true,
    },
  } as maplibregl.FillExtrusionLayerSpecification;
  addLayerInSlot(map, layer, "area-overlays", 5);
}

const replacementKey = (replacement: BuildingReplacement) =>
  `${replacement.id}|${replacement.bbox.join(",")}`;

export function BuildingExtrusionLayer() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const layerVisible = useBuildingsStore((s) => s.layerVisible);
  useOverlayExclusion("3d-buildings", layerVisible);

  const prevVisibleRef = useRef(false);
  const wasTiltedRef = useRef(false);
  const currentMap = mapRef.current;

  useEffect(() => {
    const sync = () =>
      useBuildingsStore.getState().syncNavigation(useNavigationStore.getState().status !== "idle");
    sync();
    return useNavigationStore.subscribe(sync);
  }, []);

  useEffect(() => {
    void styleVersion;
    // Reconcile selection changes immediately; callbacks read the latest store.
    void layerVisible;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    // An active selection needs a tilted camera to show geometry. The
    // selection itself remains authoritative when a user turns 3D off.
    const syncVisibility = () => {
      if (!map.getLayer(LAYER_ID)) return;
      const visibility =
        useBuildingsStore.getState().layerVisible && map.getPitch() > TILT_THRESHOLD
          ? "visible"
          : "none";
      if (map.getLayoutProperty(LAYER_ID, "visibility") !== visibility) {
        map.setLayoutProperty(LAYER_ID, "visibility", visibility);
      }
    };

    const syncLayer = () => {
      const buildingSource = findBuildingSourceReference(map);
      if (!buildingSource) return;

      if (!map.getLayer(LAYER_ID)) {
        addExtrusionLayer(map, buildingSource, buildingSource.source, buildingSource.sourceLayer);
        map.setLight({
          anchor: "viewport",
          color: "#ffffff",
          intensity: 0.4,
          position: [1.5, 210, 30],
        });
      } else {
        syncVisibility();
      }
    };

    // Hiding an existing layer must not wait for unrelated tiles to finish.
    syncVisibility();
    const unsubscribe = subscribeStyleLoaded(map, syncLayer);
    map.on("pitch", syncVisibility);
    map.on("pitchend", syncVisibility);
    return () => {
      unsubscribe();
      map.off("pitch", syncVisibility);
      map.off("pitchend", syncVisibility);
    };
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  // Buildings that drawn models replace (published to the core store) are cut
  // out of a masked copy of the basemap's building tiles. The masked source is
  // used from the first registered owner for the rest of the session, so the
  // layer is swapped once, not every time a model appears or disappears.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;
    const store = useBuildingReplacementStore;
    let live: LiveBuildingSource | null = null;
    let basemap: BuildingSourceReference | null = null;
    let previous = new Set<string>();
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;

    const refreshAvailability = () => {
      basemap = findBuildingSourceReference(map);
      live = basemap ? readLiveBuildingSource(map, basemap.source, basemap.sourceLayer) : null;
      store.getState().setMaskingAvailable(isMaskable(live, document.baseURI));
    };

    const ensureMasked = () => {
      const state = store.getState();
      if (!state.maskingAvailable || state.owners.size === 0 || !live || !basemap) return;
      const layer = map.getLayer(LAYER_ID) as { source?: string } | undefined;
      if (!layer || layer.source === MASKED_SOURCE_ID) return;
      const maskedFrom = live;
      ensureMaskProtocol(() => ({
        source: maskedFrom,
        replacements: allReplacements(store.getState()),
      }));
      addMaskedSource(map, maskedFrom);
      map.removeLayer(LAYER_ID);
      addExtrusionLayer(map, basemap, MASKED_SOURCE_ID, maskedFrom.sourceLayer);
    };

    const reloadMaskedTiles = () => {
      const current = new Set(allReplacements(store.getState()).map(replacementKey));
      const changed =
        current.size !== previous.size || [...current].some((key) => !previous.has(key));
      previous = current;
      const source = map.getSource(MASKED_SOURCE_ID) as
        | { setTiles?: (tiles: string[]) => void }
        | undefined;
      if (!source || !changed) return;
      // A new template makes MapLibre fetch every masked tile through the
      // protocol again; `refreshTiles` answers overzoomed tiles from data it
      // already holds. Tiles no replacement touches come back unchanged from
      // the protocol's raw-tile cache, so the reload is cheap.
      source.setTiles?.([`${MASKED_TEMPLATE}?r=${store.getState().revision}`]);
    };

    const onSourceData = (event: { sourceId?: string; sourceDataType?: string }) => {
      if (event.sourceDataType !== "metadata") return;
      if (basemap && event.sourceId !== basemap.source) return;
      refreshAvailability();
      ensureMasked();
    };
    const onStyleLoading = () => store.getState().setMaskingAvailable(false);

    refreshAvailability();
    ensureMasked();
    const unsubscribe = store.subscribe((state, before) => {
      if (state.owners !== before.owners || state.maskingAvailable !== before.maskingAvailable)
        ensureMasked();
      if (state.revision !== before.revision) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(reloadMaskedTiles, 150);
      }
    });
    map.on("sourcedata", onSourceData);
    map.on("styledataloading", onStyleLoading);
    return () => {
      unsubscribe();
      clearTimeout(refreshTimer);
      map.off("sourcedata", onSourceData);
      map.off("styledataloading", onStyleLoading);
    };
  }, [mapReady, styleVersion, mapRef]);

  // Selecting 3D from the layer catalog also provides a useful camera angle.
  // Turning the layer off does not change a camera angle chosen by the user.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    if (layerVisible && !prevVisibleRef.current) {
      if (map.getPitch() <= TILT_THRESHOLD) {
        moveToPitch(map, AUTO_PITCH, 800);
      }
    }

    prevVisibleRef.current = layerVisible;
  }, [layerVisible, mapReady, styleVersion, mapRef]);

  useEffect(() => {
    const map = currentMap;
    if (!map || !mapReady) return;
    const syncViewState = () => {
      const tilted = map.getPitch() > TILT_THRESHOLD;
      const state = useBuildingsStore.getState();
      if (useNavigationStore.getState().status !== "idle") {
        wasTiltedRef.current = tilted;
        return;
      }
      if (!tilted && state.cameraAutoEnableBlocked) state.setCameraAutoEnableBlocked(false);
      if (tilted === wasTiltedRef.current) return;
      wasTiltedRef.current = tilted;
      if (tilted && state.cameraAutoEnableBlocked) return;
      if (state.layerVisible === tilted) return;
      runOverlayTransaction(
        "3d-buildings",
        { panelOpen: tilted },
        { kind: "automation", owner: "3d-buildings-camera" },
      );
    };
    // An initial pitched camera may come from a saved view or deep link.
    // Only camera tilt transitions auto-select 3D; ordinary map movements
    // must not undo an explicit off choice while the camera stays tilted.
    if (map.getPitch() > TILT_THRESHOLD || wasTiltedRef.current) syncViewState();
    map.on("pitch", syncViewState);
    map.on("pitchend", syncViewState);
    return () => {
      map.off("pitch", syncViewState);
      map.off("pitchend", syncViewState);
    };
  }, [mapReady, currentMap]);

  return null;
}
