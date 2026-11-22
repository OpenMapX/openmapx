"use client";

import {
  type BuildingReplacement,
  createPlace,
  PANEL,
  useBuildingReplacementStore,
  useNavigationStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/integration-framework";
import type { Map as MaplibreMap, MapMouseEvent, MapSourceDataEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot, moveLayerToSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import {
  getMapClickOwner,
  registerCustomMapHitTester,
} from "@/integration-api/map/mapClickOwnership";
import {
  sceneSlot,
  useNavigationSceneStore,
  useSceneSlot,
} from "@/integration-api/map/navigationScene";
import {
  type SceneLight,
  sunVector,
  useSceneLight,
  useSceneLightStore,
} from "@/integration-api/map/sceneLight";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { mapTerrainProbe } from "@/integration-api/map/terrainProbe";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { areaOfInterest } from "./web/area";
import { acceptableHull, derivedHull, toReplacement } from "./web/footprint";
import { groundHeight } from "./web/grounding";
import { type Candidate, LandmarkCatalogue } from "./web/loader";
import type { LandmarkScene, ModelLighting, PlacedModel } from "./web/scene";

const OWNER = "landmark-models";

/** The three.js side of the shared scene light. */
function lightingOf(light: SceneLight): ModelLighting {
  return {
    direction: sunVector(light),
    color: light.sunColor,
    intensity: light.sunIntensity,
    ambientColor: light.ambientColor,
    ambientIntensity: light.ambientIntensity,
  };
}
const LAYER_ID = "openmapx-landmark-models";
/** The 3D view draws extrusions only while the camera is tilted past this. */
const TILT_THRESHOLD = 0.5;
const MIN_ZOOM = 13;
const DEFAULT_DETAIL_ZOOM = 17;
const RELEASE_AFTER_MS = 30_000;
const MOVE_DEBOUNCE_MS = 150;
/**
 * Above the 3D buildings (order 5): translucent model parts write no depth,
 * so extrusions drawn after them would paint over them.
 */
const SLOT_ORDER = 12;

type Polygonal = NonNullable<Candidate["asset"]["footprint"]>;

/**
 * The outline that hides a model's buildings: the provider's footprint, or,
 * where allowed, the hull of the low model's base when it is plausible.
 * Hulls are cached per asset in `hulls`.
 */
function footprintOf(
  candidate: Candidate,
  scene: LandmarkScene | null,
  hulls: Map<string, Polygonal | null>,
): Polygonal | undefined {
  const { asset } = candidate;
  if (asset.footprint) return asset.footprint;
  if (!asset.derivedFootprintAllowed) return undefined;
  if (!hulls.has(asset.id)) {
    const low = scene?.models.get(asset.id, "low");
    if (!low) return undefined;
    const hull = derivedHull(low.positions, asset.anchor);
    hulls.set(asset.id, hull && acceptableHull(hull, asset.bounds) ? hull : null);
  }
  return hulls.get(asset.id) ?? undefined;
}

/**
 * Icons and circles drawn above the models (basemap POIs, saved places, stops)
 * keep their clicks: a person taps what they see on top.
 */
function markerAbove(map: MaplibreMap, point: { x: number; y: number }): boolean {
  const order = map.getLayersOrder();
  const own = order.indexOf(LAYER_ID);
  if (own < 0) return false;
  const layers = order.slice(own + 1).filter((id) => {
    const type = map.getLayer(id)?.type;
    return type === "circle" || (type === "symbol" && !!map.getLayoutProperty(id, "icon-image"));
  });
  if (layers.length === 0) return false;
  return map.queryRenderedFeatures([point.x, point.y], { layers }).length > 0;
}

/**
 * Landmark models in the 3D view: active while the 3D view is selected, the
 * camera is tilted and close enough, navigation is idle and the basemap's
 * buildings can be masked. three.js is loaded only on first activation.
 */
export function LandmarkModelsLayer(): null {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  const selected = useOverlayLayerVisible("3d-buildings");
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const sceneSlotNow = useSceneSlot();
  const maskingAvailable = useBuildingReplacementStore((s) => s.maskingAvailable);
  const light = useSceneLight((l) => l);
  const [cameraReady, setCameraReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [scene, setScene] = useState<LandmarkScene | null>(null);
  const sceneRef = useRef<LandmarkScene | null>(null);
  sceneRef.current = scene;
  const active = selected && cameraReady && !navigating && maskingAvailable && !unsupported;

  const catalogue = useMemo(() => new LandmarkCatalogue({ apiUrl }), [apiUrl]);
  const byId = useRef(new Map<string, Candidate>());
  const grounds = useRef(new Map<string, number>());
  const hulls = useRef(new Map<string, Polygonal | null>());
  const drawn = useRef<readonly string[]>([]);
  const publishedKey = useRef("");
  const map = mapRef.current;

  /** Placed models hide their buildings, whether or not they are in view right now. */
  const publish = (ids: readonly string[]) => {
    const replacements: BuildingReplacement[] = [];
    for (const id of ids) {
      const candidate = byId.current.get(id);
      if (!candidate) continue;
      const footprint = footprintOf(candidate, scene, hulls.current);
      if (!footprint && candidate.asset.replaces.length === 0) continue;
      replacements.push(
        toReplacement(id, footprint, candidate.asset.replaces, candidate.asset.bounds),
      );
    }
    const key = replacements.map((r) => `${r.id}${r.footprint ? "+" : ""}`).join("|");
    if (key === publishedKey.current) return;
    publishedKey.current = key;
    useBuildingReplacementStore.getState().setReplacements(OWNER, replacements);
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;

  // Unmounted while active (the map stays): give the buildings back.
  useEffect(
    () => () => {
      const store = useBuildingReplacementStore.getState();
      if (store.owners.has(OWNER)) store.setReplacements(OWNER, []);
      sceneRef.current?.dispose();
    },
    [],
  );

  // Camera conditions: tilted into the 3D view and close enough for landmarks.
  useEffect(() => {
    void styleVersion;
    if (!map || !mapReady) return;
    const sync = () => setCameraReady(map.getPitch() > TILT_THRESHOLD && map.getZoom() >= MIN_ZOOM);
    sync();
    map.on("pitch", sync);
    map.on("zoom", sync);
    map.on("moveend", sync);
    return () => {
      map.off("pitch", sync);
      map.off("zoom", sync);
      map.off("moveend", sync);
    };
  }, [map, mapReady, styleVersion]);

  // Load three.js on first activation; release GPU resources after a while inactive.
  useEffect(() => {
    if (active) {
      const store = useBuildingReplacementStore.getState();
      if (!store.owners.has(OWNER)) store.setReplacements(OWNER, []);
      if (scene) return;
      let cancelled = false;
      void import("./web/scene").then(({ createLandmarkScene }) => {
        if (cancelled) return;
        setScene(
          createLandmarkScene({
            apiUrl,
            lighting: lightingOf(useSceneLightStore.getState().light),
            onUnsupported: () => setUnsupported(true),
            onFrame: (ids) => {
              drawn.current = ids;
            },
          }),
        );
      });
      return () => {
        cancelled = true;
      };
    }
    // Inactive: withdraw every replacement so the extruded buildings return.
    drawn.current = [];
    publishedKey.current = "";
    const store = useBuildingReplacementStore.getState();
    if (store.owners.has(OWNER)) store.setReplacements(OWNER, []);
    if (!scene) return;
    const timer = setTimeout(() => {
      scene.dispose();
      hulls.current.clear();
      setScene(null);
    }, RELEASE_AFTER_MS);
    return () => clearTimeout(timer);
  }, [active, scene, apiUrl]);

  // Keep the custom layer on the map while active, across style swaps. During
  // 3D navigation it sits above the route so models cover it where they stand
  // in front of it.
  useEffect(() => {
    void styleVersion;
    if (!map || !mapReady || !scene || !active) return;
    const unsubscribe = subscribeStyleLoaded(map, () => {
      if (!map.getLayer(LAYER_ID)) {
        const slot = sceneSlot(useNavigationSceneStore.getState().active);
        addLayerInSlot(map, scene.layer, slot, SLOT_ORDER);
      }
    });
    return () => {
      unsubscribe();
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    };
  }, [map, mapReady, styleVersion, scene, active]);

  useEffect(() => {
    void styleVersion;
    if (!map || !mapReady) return;
    moveLayerToSlot(map, LAYER_ID, sceneSlotNow, SLOT_ORDER);
  }, [map, mapReady, styleVersion, sceneSlotNow]);

  // The shared scene light decides the light direction and colour, and night.
  useEffect(() => {
    if (!scene) return;
    scene.layer.setLighting(lightingOf(light));
    scene.layer.setNight(light.night);
  }, [scene, light]);

  // Load the landmarks around the view and place the resident models.
  useEffect(() => {
    if (!map || !mapReady || !scene || !active) return;
    const probe = mapTerrainProbe(map);
    let controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let candidates: Candidate[] = [];

    const place = () => {
      const zoom = map.getZoom();
      const placed: PlacedModel[] = [];
      for (const candidate of candidates) {
        const { asset } = candidate;
        const wantsDetail =
          !!asset.models.detail && zoom >= (asset.detailZoom ?? DEFAULT_DETAIL_ZOOM);
        const model = scene.models.best(asset.id, wantsDetail ? "detail" : "low");
        if (!model) continue;
        let ground = groundHeight(asset, footprintOf(candidate, scene, hulls.current), probe);
        if (ground === "pending") {
          const previous = grounds.current.get(asset.id);
          if (previous === undefined) continue;
          ground = previous;
        } else {
          grounds.current.set(asset.id, ground);
        }
        scene.models.touch(asset.id);
        placed.push({
          assetId: asset.id,
          model,
          anchor: asset.anchor,
          groundM: ground,
          elevationM: asset.elevationM,
          clipBelowGround: asset.elevationM < 0 && !probe.enabled(),
          receipts: candidate.receipts,
        });
      }
      scene.layer.setPlaced(placed);
      publishRef.current(placed.map((model) => model.assetId));
    };
    const onSourceData = (event: MapSourceDataEvent) => {
      if (event.sourceId === map.getTerrain()?.source) place();
    };
    // Heights sampled before terrain changed belong to another surface.
    const onTerrain = () => {
      grounds.current.clear();
      place();
    };

    const refresh = async () => {
      controller.abort();
      controller = new AbortController();
      const bounds = map.getBounds();
      const center = map.getCenter();
      const zoom = map.getZoom();
      const area = areaOfInterest({
        center: [center.lng, center.lat],
        bounds: [bounds.getWest(), bounds.getSouth(), bounds.getEast(), bounds.getNorth()],
      });
      try {
        candidates = await catalogue.candidates(area, zoom, controller.signal);
      } catch {
        return;
      }
      byId.current = new Map(candidates.map((candidate) => [candidate.asset.id, candidate]));
      candidates.forEach(({ asset }, index) => {
        scene.models.request(asset.id, "low", asset.models.low, index);
        if (asset.models.detail && zoom >= (asset.detailZoom ?? DEFAULT_DETAIL_ZOOM))
          scene.models.request(asset.id, "detail", asset.models.detail, index);
      });
      scene.models.cancelExcept(new Set(byId.current.keys()));
      place();
    };
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), MOVE_DEBOUNCE_MS);
    };

    void catalogue
      .ensureCoverage()
      .then(refresh)
      .catch(() => undefined);
    const stopModels = scene.models.onChange(place);
    map.on("moveend", schedule);
    // Re-ground as terrain tiles arrive; a coarse parent tile is replaced by the exact one.
    map.on("sourcedata", onSourceData);
    map.on("terrain", onTerrain);
    map.on("idle", place);
    return () => {
      controller.abort();
      clearTimeout(timer);
      stopModels();
      map.off("moveend", schedule);
      map.off("sourcedata", onSourceData);
      map.off("terrain", onTerrain);
      map.off("idle", place);
    };
  }, [map, mapReady, scene, active, catalogue]);

  // Models swallow clicks (no pin under a model) and open the replaced building.
  useEffect(() => {
    if (!map || !mapReady || !scene || !active) return;
    const unregister = registerCustomMapHitTester(
      map,
      OWNER,
      (point) => scene.layer.pick(point) !== null && !markerAbove(map, point),
    );
    const onClick = (event: MapMouseEvent) => {
      if (getMapClickOwner(event) !== "custom-content") return;
      const id = scene.layer.pick(event.point);
      const asset = id ? byId.current.get(id)?.asset : undefined;
      const osm = asset?.replaces[0];
      if (!asset || !osm) return;
      usePlaceStore.getState().setSelectedPlace(
        createPlace({
          primaryScheme: "osm",
          ids: { osm, ...(asset.wikidata ? { wikidata: asset.wikidata } : {}) },
          name: asset.name,
          address: "",
          coordinates: asset.anchor,
        }),
      );
      useSidebarStore.getState().openSidebar(PANEL.PLACE);
    };
    map.on("click", onClick);
    return () => {
      unregister();
      map.off("click", onClick);
    };
  }, [map, mapReady, scene, active]);

  // The shared pipeline owns the cursor; overlays with rendered hits rank above.
  useMapOverlayInteraction({
    id: OWNER,
    layerIds: [LAYER_ID],
    priority: 0,
    enabled: !!map && mapReady && !!scene && active,
    hitTest: (point) =>
      !!map && !!scene && scene.layer.pick(point) !== null && !markerAbove(map, point),
  });

  const attributionOptions = useMemo(
    () => ({
      resolveCustomContributors: (): Attribution[] =>
        drawn.current.flatMap((id) => byId.current.get(id)?.receipts ?? []),
    }),
    [],
  );
  useRenderedMapAttributions(OWNER, [], active && !!scene, attributionOptions);

  return null;
}
