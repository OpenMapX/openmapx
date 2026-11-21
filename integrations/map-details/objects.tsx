"use client";

import { sampleTerrainGrid } from "@openmapx/core";
import type { Attribution } from "@openmapx/integration-framework";
import type { Map as MaplibreMap, MapSourceDataEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import {
  type SceneLight,
  sunVector,
  useSceneLight,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { mapTerrainProbe } from "@/integration-api/map/terrainProbe";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { findForestSource } from "./web/basemap-source";
import type { Instances } from "./web/derive/forest";
import { LRU } from "./web/lru";
import type { MapDetailsObjectsLayer, ObjectLighting } from "./web/objects-layer";
import { CELL_CACHE_SIZE, cellKey, selectInstances, visibleCells } from "./web/selection";
import { detectTier, TIER_BUDGETS } from "./web/tiers";
import type { MapDetailsWorkerClient } from "./web/worker-client";

/** Above the 3D buildings (order 5) and the landmark models (order 12). */
const OBJECTS_SLOT_ORDER = 13;
const RELEASE_AFTER_MS = 30_000;
const MOVE_DEBOUNCE_MS = 150;
const MOVE_REBUILD_M = 150;
const SELECT_THROTTLE_MS = 250;
const MIN_ZOOM = 16;
const TERRAIN_GRID = 9;
const CELL_ZOOM = 16;

/** The three.js side of the shared scene light. */
export function lightingOf(light: SceneLight): ObjectLighting {
  return {
    direction: sunVector(light),
    color: light.sunColor,
    intensity: light.sunIntensity,
    ambientColor: light.ambientColor,
    ambientIntensity: light.ambientIntensity,
    night: light.night,
  };
}

function cellBounds(x: number, y: number): [number, number, number, number] {
  const n = 2 ** CELL_ZOOM;
  const lat = (row: number) =>
    (Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / n))) * 180) / Math.PI;
  return [(x / n) * 360 - 180, lat(y + 1), ((x + 1) / n) * 360 - 180, lat(y)];
}

function groundDistanceM(a: { lng: number; lat: number }, b: { lng: number; lat: number }): number {
  const dx = (a.lng - b.lng) * Math.cos((a.lat * Math.PI) / 180) * 111_320;
  const dy = (a.lat - b.lat) * 110_540;
  return Math.hypot(dx, dy);
}

function deviceTier() {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return detectTier({
    pointerCoarse:
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
    deviceMemory: (nav as { deviceMemory?: number } | undefined)?.deviceMemory,
    hardwareConcurrency: nav?.hardwareConcurrency,
  });
}

/**
 * Forests and street objects (spec §6.3, §6.4): three.js loads on first
 * activation and is released 30 s after deactivation; z16 cells around the
 * view are filled by the worker and the nearest instances drawn within the
 * device budget; cells wait for exact terrain before they show.
 */
export function useMapDetailsObjects({
  map,
  active,
  client,
  streetTemplate,
  satellite,
  contributors,
}: {
  map: MaplibreMap | null;
  active: boolean;
  client: MapDetailsWorkerClient | null;
  streetTemplate: string | null;
  satellite: boolean;
  contributors: readonly Attribution[];
}): void {
  const [scene, setScene] = useState<{ layer: MapDetailsObjectsLayer } | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const light = useSceneLight((l) => l);
  const objectsActive = active && !unsupported;
  const cells = useRef(new LRU<string, Instances[]>(CELL_CACHE_SIZE));
  const budget = useMemo(() => TIER_BUDGETS[deviceTier()], []);

  // Load three.js on first activation; release it after a while inactive.
  useEffect(() => {
    if (objectsActive) {
      if (scene) return;
      let cancelled = false;
      void import("./web/scene").then(({ createMapDetailsScene }) => {
        if (cancelled) return;
        setScene(
          createMapDetailsScene({
            lighting: lightingOf(useSceneLightStore.getState().light),
            onUnsupported: () => setUnsupported(true),
          }),
        );
      });
      return () => {
        cancelled = true;
      };
    }
    if (!scene) return;
    // Dropping the scene disposes it (the effect below).
    const timer = setTimeout(() => {
      cells.current.clear();
      setScene(null);
    }, RELEASE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [objectsActive, scene]);

  useEffect(() => () => scene?.layer.dispose(), [scene]);

  // Keep the custom layer on the map while active, across style swaps.
  useEffect(() => {
    if (!map || !scene || !objectsActive) return;
    const { layer } = scene;
    const unsubscribe = subscribeStyleLoaded(map, () => {
      if (!map.getLayer(layer.id)) addLayerInSlot(map, layer, "area-overlays", OBJECTS_SLOT_ORDER);
    });
    return () => {
      unsubscribe();
      if (map.getLayer(layer.id)) map.removeLayer(layer.id);
    };
  }, [map, scene, objectsActive]);

  useEffect(() => {
    scene?.layer.setLighting(lightingOf(light));
  }, [scene, light]);

  useEffect(() => {
    scene?.layer.setSatellite(satellite);
  }, [scene, satellite]);

  // Fill the cells around the view and select what to draw.
  useEffect(() => {
    if (!map || !scene || !client || !objectsActive) return;
    const { layer } = scene;
    const probe = mapTerrainProbe(map);
    const grids = new Map<string, Float32Array | "pending" | null>();
    let controller = new AbortController();
    let sourceKey = "";
    let lastCentre: { lng: number; lat: number } | null = null;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    let selectTimer: ReturnType<typeof setTimeout> | undefined;
    let lastSelect = 0;

    const viewCells = () => {
      const bounds = map.getBounds();
      const canvas = map.getCanvas();
      // The ground under the bottom centre of the screen: the camera's foreground.
      const foreground = map.unproject([canvas.clientWidth / 2, canvas.clientHeight]);
      return visibleCells(
        [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
        [foreground.lng, foreground.lat],
      );
    };

    const select = () => {
      clearTimeout(selectTimer);
      selectTimer = undefined;
      lastSelect = Date.now();
      const centre = map.getCenter();
      const zoom = map.getZoom();
      const chosen = new Map<string, Instances[]>();
      if (zoom >= MIN_ZOOM)
        for (const cell of viewCells()) {
          const key = cellKey(cell.x, cell.y);
          const instances = cells.current.get(`${sourceKey}|${key}`);
          if (!instances) continue;
          chosen.set(key, instances);
          if (!grids.has(key)) {
            const grid = sampleTerrainGrid(probe, ...cellBounds(cell.x, cell.y), TERRAIN_GRID);
            grids.set(key, grid);
            layer.setTerrain(key, grid);
          }
        }
      layer.setInstances(
        selectInstances(chosen, { lng: centre.lng, lat: centre.lat }, budget, zoom),
        [centre.lng, centre.lat],
      );
    };
    const scheduleSelect = () => {
      if (selectTimer) return;
      const wait = SELECT_THROTTLE_MS - (Date.now() - lastSelect);
      if (wait <= 0) select();
      else selectTimer = setTimeout(select, wait);
    };

    const rebuild = () => {
      clearTimeout(debounce);
      debounce = undefined;
      controller.abort();
      controller = new AbortController();
      const { signal } = controller;
      const centre = map.getCenter();
      lastCentre = { lng: centre.lng, lat: centre.lat };
      if (map.getZoom() >= MIN_ZOOM) {
        const forest = findForestSource(map.getStyle(), (id) => map.getSource(id));
        const street = streetTemplate;
        sourceKey = `${street ?? ""}|${forest?.templates.join(" ") ?? ""}|${forest?.maxzoom ?? ""}`;
        for (const cell of viewCells()) {
          const key = `${sourceKey}|${cellKey(cell.x, cell.y)}`;
          if (cells.current.has(key)) continue;
          client
            .objects(
              {
                cellX: cell.x,
                cellY: cell.y,
                streetTemplate: street,
                basemapTemplates: forest?.templates ?? [],
                basemapMaxzoom: forest?.maxzoom ?? 14,
              },
              signal,
            )
            .then((instances) => {
              if (!instances || signal.aborted) return;
              cells.current.set(key, instances);
              scheduleSelect();
            })
            .catch(() => undefined);
        }
      }
      select();
    };

    const onMoveEnd = () => {
      clearTimeout(debounce);
      debounce = setTimeout(rebuild, MOVE_DEBOUNCE_MS);
    };
    const onMove = () => {
      if (lastCentre && groundDistanceM(map.getCenter(), lastCentre) > MOVE_REBUILD_M) rebuild();
    };
    // Cells waiting for terrain are sampled again as terrain tiles arrive.
    const onSourceData = (event: MapSourceDataEvent) => {
      if (event.sourceId !== map.getTerrain()?.source) return;
      for (const [key, grid] of grids) if (grid === "pending") grids.delete(key);
      scheduleSelect();
    };
    const onTerrain = () => {
      grids.clear();
      scheduleSelect();
    };

    rebuild();
    map.on("moveend", onMoveEnd);
    map.on("move", onMove);
    map.on("sourcedata", onSourceData);
    map.on("terrain", onTerrain);
    return () => {
      controller.abort();
      clearTimeout(debounce);
      clearTimeout(selectTimer);
      map.off("moveend", onMoveEnd);
      map.off("move", onMove);
      map.off("sourcedata", onSourceData);
      map.off("terrain", onTerrain);
    };
    // A street template that arrives after the first rebuild (a late TileJSON) fills the cells again.
  }, [map, scene, client, objectsActive, budget, streetTemplate]);

  // OpenStreetMap is owed only while street objects are drawn; planted forests come from the basemap.
  const attribution = useMemo(
    () => ({
      resolveCustomContributors: (): readonly Attribution[] =>
        scene?.layer.drewMapped() ? contributors : [],
    }),
    [scene, contributors],
  );
  useRenderedMapAttributions("map-details-objects", [], objectsActive && !!scene, attribution);
}
