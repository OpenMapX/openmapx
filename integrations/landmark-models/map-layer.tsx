"use client";

import { useColorScheme } from "@mui/material/styles";
import {
  type BuildingReplacement,
  createPlace,
  PANEL,
  useBuildingReplacementStore,
  useLayerStore,
  useNavigationStore,
  usePlaceStore,
  useSidebarStore,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/integration-framework";
import type { MapMouseEvent } from "maplibre-gl";
import { useEffect, useMemo, useRef, useState } from "react";
import { addLayerInSlot } from "@/integration-api/map/layerStack";
import { useMap } from "@/integration-api/map/MapContext";
import {
  getMapClickOwner,
  registerCustomMapHitTester,
} from "@/integration-api/map/mapClickOwnership";
import { subscribeStyleLoaded } from "@/integration-api/map/styleLoadedSync";
import { useOverlayLayerVisible } from "@/integration-api/overlay/useOverlayStoreState";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { useEnv } from "@/integration-api/runtime/EnvProvider";
import { areaOfInterest } from "./web/area";
import { acceptableHull, derivedHull, toReplacement } from "./web/footprint";
import { groundHeight, mapTerrainProbe } from "./web/grounding";
import { type Candidate, LandmarkCatalogue } from "./web/loader";
import type { LandmarkScene, PlacedModel } from "./web/scene";

const OWNER = "landmark-models";
const LAYER_ID = "openmapx-landmark-models";
/** The 3D view draws extrusions only while the camera is tilted past this. */
const TILT_THRESHOLD = 0.5;
const MIN_ZOOM = 13;
const DEFAULT_DETAIL_ZOOM = 17;
const RELEASE_AFTER_MS = 30_000;
const MOVE_DEBOUNCE_MS = 150;

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
 * Landmark models in the 3D view: active while the 3D view is selected, the
 * camera is tilted and close enough, navigation is idle and the basemap's
 * buildings can be masked. three.js is loaded only on first activation.
 */
export function LandmarkModelsLayer(): null {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { apiUrl } = useEnv();
  const selected = useOverlayLayerVisible("3d-buildings");
  const navigating = useNavigationStore((s) => s.status !== "idle");
  const maskingAvailable = useBuildingReplacementStore((s) => s.maskingAvailable);
  const baseLayer = useLayerStore((s) => s.activeLayer);
  // The app themes through MUI colour schemes, so `palette.mode` stays "light".
  const { mode, systemMode } = useColorScheme();
  const dark = (mode === "system" ? systemMode : mode) === "dark";
  const [cameraReady, setCameraReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [scene, setScene] = useState<LandmarkScene | null>(null);
  const active = selected && cameraReady && !navigating && maskingAvailable && !unsupported;

  const catalogue = useMemo(() => new LandmarkCatalogue({ apiUrl }), [apiUrl]);
  const byId = useRef(new Map<string, Candidate>());
  const grounds = useRef(new Map<string, number>());
  const hulls = useRef(new Map<string, Polygonal | null>());
  const drawn = useRef<readonly string[]>([]);
  const publishedKey = useRef("");
  const map = mapRef.current;

  const publish = (ids: readonly string[]) => {
    drawn.current = ids;
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
    const key = replacements.map((r) => r.id).join("|");
    if (key === publishedKey.current) return;
    publishedKey.current = key;
    useBuildingReplacementStore.getState().setReplacements(OWNER, replacements);
  };
  const publishRef = useRef(publish);
  publishRef.current = publish;

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
            onUnsupported: () => setUnsupported(true),
            onFrame: (ids) => publishRef.current(ids),
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

  // Keep the custom layer on the map while active, across style swaps.
  useEffect(() => {
    void styleVersion;
    if (!map || !mapReady || !scene || !active) return;
    const unsubscribe = subscribeStyleLoaded(map, () => {
      if (!map.getLayer(LAYER_ID)) addLayerInSlot(map, scene.layer, "area-overlays", 6);
    });
    return () => {
      unsubscribe();
      if (map.getLayer(LAYER_ID)) map.removeLayer(LAYER_ID);
    };
  }, [map, mapReady, styleVersion, scene, active]);

  // Night shading follows the dark theme, except over imagery.
  useEffect(() => {
    scene?.layer.setNight(dark && baseLayer !== "satellite");
  }, [scene, dark, baseLayer]);

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
    for (const event of ["sourcedata", "terrain", "idle"] as const) map.on(event, place);
    return () => {
      controller.abort();
      clearTimeout(timer);
      stopModels();
      map.off("moveend", schedule);
      for (const event of ["sourcedata", "terrain", "idle"] as const) map.off(event, place);
    };
  }, [map, mapReady, scene, active, catalogue]);

  // Models swallow clicks (no pin under a model) and open the replaced building.
  useEffect(() => {
    if (!map || !mapReady || !scene || !active) return;
    const unregister = registerCustomMapHitTester(
      map,
      OWNER,
      (point) => scene.layer.pick(point) !== null,
    );
    let frame = 0;
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
    const onMouseMove = (event: MapMouseEvent) => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        map.getCanvas().style.cursor = scene.layer.pick(event.point) ? "pointer" : "";
      });
    };
    map.on("click", onClick);
    map.on("mousemove", onMouseMove);
    return () => {
      unregister();
      cancelAnimationFrame(frame);
      map.off("click", onClick);
      map.off("mousemove", onMouseMove);
    };
  }, [map, mapReady, scene, active]);

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
