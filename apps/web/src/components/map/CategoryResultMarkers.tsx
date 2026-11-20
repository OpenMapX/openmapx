"use client";

import type { BrandDetail, BrandKind, CategoryPlace } from "@openmapx/core";
import {
  API_ENDPOINTS,
  apiClient,
  categoryPlaceToPlace,
  firstBrandIdentity,
  isDisplayablePhoto,
  makeSyntheticStopPlace,
  PANEL,
  type PlacePhoto,
  poiCategoryIconPath,
  proxyImageUrl,
  resolvePoiCategoryId,
  resolveStopAsPlace,
  useCategorySearchStore,
  usePlaceStore,
  useSidebarStore,
  useTransitStops,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import {
  contributorsForField,
  contributorsForRecordFields,
  readCapturedContributors,
  readCapturedFieldContributors,
  serializeContributors,
  snapshotContributors,
} from "@openmapx/mobility-core/contributors";
import type { TransitStop, TransportMode } from "@openmapx/mobility-core/transit";
import type {
  ExpressionSpecification,
  FilterSpecification,
  Map as MaplibreMap,
  MapMouseEvent,
} from "maplibre-gl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { usePinMarker } from "@/hooks/usePinMarker";
import { usePlaceEnrichment } from "@/hooks/usePlaceEnrichment";
import { useMap } from "@/integration-api/map/MapContext";
import type { MapLayerGroup, SlottedLayer } from "@/integration-api/map/mapLayerGroup";
import { useMapLayerGroup } from "@/integration-api/map/useMapLayerGroup";
import { useMapOverlayInteraction } from "@/integration-api/map/useMapOverlayInteraction";
import { useRenderedMapAttributions } from "@/integration-api/overlay/useRenderedMapAttributions";
import { createBrandMarkerSvg, createMarkerSvg } from "@/lib/markerSvg";
import { useExploreReachResults } from "@/lib/useExploreReachResults";
import { resultMarkerLayers } from "./resultMarkerLayers";

const SOURCE_ID = "category-results-source";
const LAYER_ID = "category-results-layer";
const LABEL_LAYER_ID = "category-results-labels";

/**
 * Creates a 64×64 SVG (2× for retina): red circle with a white MUI icon path.
 * The icon uses a 24×24 viewBox scaled and centered inside the circle.
 */

function loadMarkerImage(
  map: MaplibreMap,
  imageId: string,
  iconPath: string,
  isCurrent: () => boolean,
): Promise<void> {
  return new Promise((resolve) => {
    if (map.hasImage(imageId)) {
      resolve();
      return;
    }
    const img = new Image(64, 64);
    img.onload = () => {
      if (isCurrent() && !map.hasImage(imageId)) map.addImage(imageId, img, { pixelRatio: 2 });
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createMarkerSvg(iconPath))}`;
  });
}

/** The brand identity of one result — its QID and which `*:wikidata` key
 *  carried it — or undefined when it has none. Delegates to the shared
 *  `firstBrandIdentity` so this never disagrees with facet aggregation
 *  (`brandOptions`) about which tag wins. */
export function placeBrandIdentity(
  place: CategoryPlace,
): { qid: string; kind: BrandKind } | undefined {
  return firstBrandIdentity(place.osmTags);
}

/** The brand identity of one result, or undefined when it has none. */
export function placeBrandQid(place: CategoryPlace): string | undefined {
  return placeBrandIdentity(place)?.qid;
}

/** Distinct brand QIDs in a result set, in first-seen order. */
export function distinctBrandQids(results: CategoryPlace[]): string[] {
  const seen = new Set<string>();
  for (const place of results) {
    const qid = placeBrandQid(place);
    if (qid) seen.add(qid);
  }
  return [...seen];
}

/** Namespaced so a brand image can never collide with a category image. */
export function brandImageId(qid: string): string {
  return `brand-marker-${qid}`;
}

/**
 * Loads one brand's logo into the map's image registry, fetching its detail
 * record (for the Commons filename) and the logo bytes together. This calls
 * the brand-detail route directly with `apiClient.get`, outside React Query,
 * so it does not share a cache entry with `useBrandDetail`/`useBrandLogos` —
 * `CategoryFilterBar`'s facet chips request the same QIDs concurrently via
 * `useBrandLogos`. The two calls just land on the same HTTP route, which
 * carries its own `Cache-Control` header, so the duplication costs a cache
 * hit rather than a second catalog lookup.
 *
 * Resolves `false` without registering an image when the brand has no logo or
 * any step fails; callers fall back to the category marker, so a broken or
 * missing logo costs a plain pin rather than a missing one.
 */
const brandAssetReceipts = new WeakMap<MaplibreMap, Map<string, readonly Attribution[]>>();

/** Receipts certify only the image currently installed in this map; clone before exposing them. */
export function loadedBrandMarkerContributors(map: MaplibreMap, qid: string): Attribution[] {
  const id = brandImageId(qid);
  return map.hasImage(id) ? snapshotContributors(brandAssetReceipts.get(map)?.get(id) ?? []) : [];
}

export async function loadBrandMarkerImage(
  map: MaplibreMap,
  qid: string,
  isCurrent: () => boolean = () => true,
): Promise<boolean> {
  const imageId = brandImageId(qid);
  if (map.hasImage(imageId) && brandAssetReceipts.get(map)?.has(imageId)) return true;

  try {
    const detail = await apiClient.get<BrandDetail>(`${API_ENDPOINTS.brandDetail}/${qid}`, {
      catalogue: "2",
    });
    if (!detail.logoFile) return false;

    const photo = await apiClient.get<PlacePhoto & { logoFile: string }>(
      `${API_ENDPOINTS.brandLogoAttribution}/${qid}/logo-attribution`,
    );
    if (
      photo.logoFile !== detail.logoFile ||
      !isDisplayablePhoto(photo) ||
      !photo.contributors?.length
    )
      return false;
    const receipts = snapshotContributors(
      contributorsForField(detail, "logoFile"),
      photo.contributors,
    );
    const response = await fetch(proxyImageUrl(photo.thumbnailUrl ?? photo.url));
    if (!response.ok) return false;
    const blob = await response.blob();
    const dataUri = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(new Error("logo read failed"));
      reader.readAsDataURL(blob);
    });

    return await new Promise<boolean>((resolve) => {
      const img = new Image(64, 64);
      img.onload = () => {
        if (!isCurrent()) {
          resolve(false);
          return;
        }
        // An old uncredited image cannot certify the newly acquired file.
        if (map.hasImage(imageId)) map.removeImage(imageId);
        map.addImage(imageId, img, { pixelRatio: 2 });
        let captured = brandAssetReceipts.get(map);
        if (!captured) {
          captured = new Map();
          brandAssetReceipts.set(map, captured);
        }
        captured.set(imageId, receipts);
        resolve(true);
      };
      img.onerror = () => resolve(false);
      img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
        createBrandMarkerSvg(dataUri),
      )}`;
    });
  } catch {
    return false;
  }
}

const TEXT_MARKER_IMAGE_ID = "category-marker-text";
const CATEGORY_MARKER_PREFIX = "category-marker-";

export function categoryMarkerImageId(categoryId: string): string {
  return `${CATEGORY_MARKER_PREFIX}${categoryId}`;
}

/**
 * A text-search result's pin carries its own category's glyph, so a search
 * that turns up cafés and restaurants shows a cup and a fork rather than a
 * magnifier on every pin. Places of no known category keep the magnifier.
 */
export function textResultImageId(place: CategoryPlace): string {
  const tags = place.osmTags ?? {};
  for (const candidate of [place.category, tags.amenity, tags.shop, tags.tourism]) {
    const categoryId = candidate ? resolvePoiCategoryId(candidate) : undefined;
    if (categoryId) return categoryMarkerImageId(categoryId);
  }
  return TEXT_MARKER_IMAGE_ID;
}

function markerIconPath(imageId: string): string {
  return imageId === TEXT_MARKER_IMAGE_ID
    ? TEXT_MARKER_ICON_PATH
    : poiCategoryIconPath(imageId.slice(CATEGORY_MARKER_PREFIX.length));
}

export function buildGeoJson(
  results: CategoryPlace[],
  markerImageFor: (place: CategoryPlace) => string,
  brandImageIds: ReadonlySet<string>,
  categoryFromResult = false,
  assetReceipts: ReadonlyMap<string, readonly Attribution[]> = new Map(),
) {
  return {
    type: "FeatureCollection" as const,
    features: results.map((place) => {
      const qid = placeBrandQid(place);
      const branded = qid !== undefined && brandImageIds.has(brandImageId(qid));
      const imageId = branded && qid !== undefined ? brandImageId(qid) : markerImageFor(place);
      const markerFields = ["coordinates"];
      if (branded) {
        const identity = placeBrandIdentity(place);
        if (identity) markerFields.push(`osmTags.${identity.kind}:wikidata`);
      } else if (categoryFromResult) {
        for (const [field, candidate] of [
          ["category", place.category],
          ["osmTags.amenity", place.osmTags?.amenity],
          ["osmTags.shop", place.osmTags?.shop],
          ["osmTags.tourism", place.osmTags?.tourism],
        ] as const) {
          if (candidate && resolvePoiCategoryId(candidate)) {
            markerFields.push(field);
            break;
          }
        }
      }
      return {
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: place.coordinates },
        properties: {
          id: place.id,
          name: place.name,
          address: place.address ?? "",
          category: place.category ?? "",
          phone: place.phone ?? "",
          website: place.website ?? "",
          openingHours: place.openingHours ?? "",
          imageId,
          _mapMarkerAttributions: serializeContributors(
            snapshotContributors(
              contributorsForRecordFields(place, markerFields),
              branded ? (assetReceipts.get(imageId) ?? []) : [],
            ),
          ),
          _mapLabelAttributions: serializeContributors(
            contributorsForRecordFields(place, ["coordinates", "name"]),
          ),
        },
      };
    }),
  };
}

const TRANSIT_SOURCE_ID = "transit-stops-source";
const TRANSIT_LAYER_ID = "transit-stops-layer";
const TRANSIT_LABEL_LAYER_ID = "transit-stops-labels";

const TRANSIT_BUS_ICON_PATH =
  "M4 16c0 .88.39 1.67 1 2.22V20c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1h8v1c0 .55.45 1 1 1h1c.55 0 1-.45 1-1v-1.78c.61-.55 1-1.34 1-2.22V6c0-3.5-3.58-4-8-4s-8 .5-8 4v10zm3.5 1c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V6h12v5z";

const TEXT_MARKER_ICON_PATH =
  "M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z";

const TRANSIT_MODE_ICON_PATHS: Partial<Record<TransportMode, string>> = {
  rail: "M4 15.5C4 17.43 5.57 19 7.5 19L6 20.5v.5h12v-.5L16.5 19c1.93 0 3.5-1.57 3.5-3.5V5c0-3.5-3.58-4-8-4s-8 .5-8 4v10.5zm8 1.5c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm6-7H6V5h12v5z",
  bus: TRANSIT_BUS_ICON_PATH,
  tram: "M19 16.94V8.5c0-2.79-2.61-3.4-5.5-3.5l.9-1.5H19V2H5v1.5h4.4L8.5 5C5.6 5.1 3 5.73 3 8.5v8.44c0 1.45 1.19 2.56 2.59 2.56L4 21v.5h2l2-2h8l2 2h2V21l-1.59-1.5c1.4 0 2.59-1.11 2.59-2.56zM12.5 5h-1l.9-1.5h.2L12.5 5zM7.5 17c-.83 0-1.5-.67-1.5-1.5S6.67 14 7.5 14s1.5.67 1.5 1.5S8.33 17 7.5 17zm9 0c-.83 0-1.5-.67-1.5-1.5s.67-1.5 1.5-1.5 1.5.67 1.5 1.5-.67 1.5-1.5 1.5zm1.5-6H6V8.5c0-.67.69-1 3-1h6c2.31 0 3 .33 3 1V11z",
};

function createTransitMarkerSvg(mode: TransportMode): string {
  const iconPath = TRANSIT_MODE_ICON_PATHS[mode] ?? TRANSIT_BUS_ICON_PATH;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48">
    <circle cx="24" cy="24" r="21" fill="#00695C" stroke="white" stroke-width="3"/>
    <path d="${iconPath}" fill="white" transform="translate(8, 8) scale(1.333)"/>
  </svg>`;
}

function loadTransitMarkerImage(
  map: MaplibreMap,
  mode: TransportMode,
  isCurrent: () => boolean,
): Promise<string> {
  const imageId = `transit-marker-${mode}`;
  return new Promise((resolve) => {
    if (map.hasImage(imageId)) {
      resolve(imageId);
      return;
    }
    const img = new Image(48, 48);
    img.onload = () => {
      if (isCurrent() && !map.hasImage(imageId)) map.addImage(imageId, img, { pixelRatio: 2 });
      resolve(imageId);
    };
    img.onerror = () => resolve(imageId);
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(createTransitMarkerSvg(mode))}`;
  });
}

function buildTransitGeoJson(stops: TransitStop[]) {
  return {
    type: "FeatureCollection" as const,
    features: stops.map((stop) => ({
      type: "Feature" as const,
      geometry: { type: "Point" as const, coordinates: [stop.lng, stop.lat] as [number, number] },
      properties: {
        id: stop.id,
        name: stop.name,
        lat: stop.lat,
        lng: stop.lng,
        modes: JSON.stringify(stop.modes),
        provider: stop.provider,
        platformCode: stop.platformCode ?? "",
        parentStationId: stop.parentStationId ?? "",
        imageId: `transit-marker-${stop.modes[0] ?? "bus"}`,
        _mapMarkerAttributions: serializeContributors(
          contributorsForRecordFields(stop, ["lat", "lng", "modes"]),
        ),
        _mapLabelAttributions: serializeContributors(
          contributorsForRecordFields(stop, ["lat", "lng", "name"]),
        ),
        _recordContributors: serializeContributors(stop.contributors ?? []),
        _fieldContributors: JSON.stringify(stop.fieldContributors),
      },
    })),
  };
}

/** Results the user asked for win over ambient overlays drawn beneath them. */
const RESULT_INTERACTION_PRIORITY = 200;

/**
 * Whether the pointer is over the hover pin drawn above a result: its DOM
 * element, or the box it covers above the result's point.
 */
function overHoverPin(
  map: MaplibreMap,
  event: MapMouseEvent | undefined,
  pin: CategoryPlace | null,
): boolean {
  if (!event) return false;
  const target = event.originalEvent?.target;
  if (target instanceof Element && target.closest("[data-openmapx-pin-marker]")) return true;
  if (!pin) return false;
  const point = map.project(pin.coordinates);
  return (
    Math.abs(event.point.x - point.x) <= 16 &&
    event.point.y >= point.y - 36 &&
    event.point.y <= point.y + 8
  );
}

export function CategoryResultMarkers() {
  const { mapRef, styleVersion, flyTo } = useMap();
  useRenderedMapAttributions(
    "category-results",
    [LAYER_ID, LABEL_LAYER_ID, TRANSIT_LAYER_ID, TRANSIT_LABEL_LAYER_ID],
    true,
    {
      resolveFeatureContributors: (feature) =>
        readCapturedContributors(
          feature.properties?.[
            feature.layer.id === LABEL_LAYER_ID || feature.layer.id === TRANSIT_LABEL_LAYER_ID
              ? "_mapLabelAttributions"
              : "_mapMarkerAttributions"
          ],
        ) ?? [],
    },
  );
  const activeCategory = useCategorySearchStore((s) => s.activeCategory);
  const mode = useCategorySearchStore((s) => s.mode);
  const textQuery = useCategorySearchStore((s) => s.textQuery);
  const searchBbox = useCategorySearchStore((s) => s.searchBbox);
  const hoveredCategoryPlaceId = useCategorySearchStore((s) => s.hoveredCategoryPlaceId);
  const setHoveredCategoryPlaceId = useCategorySearchStore((s) => s.setHoveredCategoryPlaceId);
  const { setSelectedPlace } = usePlaceStore();
  const { selectWithEnrichment } = usePlaceEnrichment();
  const selectedPlace = usePlaceStore((state) => state.selectedPlace);

  const { filtered: results, isTransitCategory } = useExploreReachResults();
  const { data: transitStops } = useTransitStops(isTransitCategory ? searchBbox : null);

  // Resolve hovered place for the pin marker
  const selectedResultId = selectedPlace
    ? (results?.find((place) => categoryPlaceToPlace(place).id === selectedPlace.id)?.id ?? null)
    : null;
  const hoveredPlace = results?.find((p) => p.id === hoveredCategoryPlaceId) ?? null;
  const selectResult = useCallback(
    (place: CategoryPlace) => {
      flyTo(place.coordinates, 17);
      setSelectedPlace(categoryPlaceToPlace(place, activeCategory ?? undefined));
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    },
    [flyTo, setSelectedPlace, activeCategory],
  );
  const hoverPinPlace = hoveredPlace?.id === selectedResultId ? null : hoveredPlace;
  const activateHoverPin = useCallback(() => {
    if (hoverPinPlace) selectResult(hoverPinPlace);
  }, [hoverPinPlace, selectResult]);
  usePinMarker(
    hoverPinPlace?.coordinates ?? null,
    hoverPinPlace?.name ?? "",
    true,
    undefined,
    hoverPinPlace ? activateHoverPin : undefined,
    hoverPinPlace ? contributorsForField(hoverPinPlace, "coordinates") : [],
    hoverPinPlace ? contributorsForRecordFields(hoverPinPlace, ["coordinates", "name"]) : [],
  );

  const focusFilter = useMemo<FilterSpecification>(
    () => ["!=", ["get", "id"], selectedResultId ?? ""],
    [selectedResultId],
  );
  // The hovered result keeps its marker under the hover pin, and only its name
  // fades out because the pin labels it. Hiding the label through opacity
  // rather than a filter keeps the symbol placed, so it still answers hover
  // queries and the neighbouring labels do not reshuffle.
  const hoverLabelOpacity = useMemo<ExpressionSpecification>(
    () => ["case", ["==", ["get", "id"], hoveredCategoryPlaceId ?? ""], 0, 1],
    [hoveredCategoryPlaceId],
  );

  const markerImageFor = useMemo(
    () => (mode === "text" ? textResultImageId : () => categoryMarkerImageId(activeCategory ?? "")),
    [mode, activeCategory],
  );
  const categoryGeojson = useMemo(
    () => buildGeoJson(results ?? [], markerImageFor, new Set(), mode === "text"),
    [results, markerImageFor, mode],
  );
  const markerImageIds = useMemo(
    () => [...new Set((results ?? []).map(markerImageFor))],
    [results, markerImageFor],
  );
  const qids = useMemo(() => distinctBrandQids(results ?? []), [results]);
  const transitModes = useMemo(
    () => [...new Set((transitStops ?? []).flatMap((stop) => stop.modes))],
    [transitStops],
  );
  const transitGeojson = useMemo(() => buildTransitGeoJson(transitStops ?? []), [transitStops]);

  const hasContext = mode === "text" ? Boolean(textQuery) : Boolean(activeCategory);

  // Brand logos load after the category icons, so a slow or empty logo fetch
  // never holds markers back. Each finished load re-renders, and the matching
  // pins switch to their logo.
  const [brandLoads, setBrandLoads] = useState(0);
  const categoryData = useMemo(() => {
    void brandLoads;
    void styleVersion;
    const map = mapRef.current;
    const loaded = new Set(
      map
        ? qids
            .map(brandImageId)
            .filter((id) => brandAssetReceipts.get(map)?.has(id) && map.hasImage(id))
        : [],
    );
    return loaded.size === 0 || !map
      ? categoryGeojson
      : buildGeoJson(
          results ?? [],
          markerImageFor,
          loaded,
          mode === "text",
          brandAssetReceipts.get(map),
        );
  }, [brandLoads, styleVersion, mapRef, qids, categoryGeojson, results, markerImageFor, mode]);

  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** The images the current descriptor asks for; a load for any other is stale. */
  const wantedImages = useRef(new Set<string>());
  /**
   * An image load belongs to the source generation it first sees and to the
   * results that asked for it: a style change replaces the source, a new
   * search replaces the images, and a load for either old one is dropped.
   */
  const ownsSource = useCallback(
    (map: MaplibreMap, sourceId: string, imageId: string) => {
      let generation: unknown;
      return () => {
        const current = map.getSource(sourceId);
        generation ??= current;
        return (
          mounted.current &&
          mapRef.current === map &&
          current === generation &&
          wantedImages.current.has(imageId)
        );
      };
    },
    [mapRef],
  );

  const group = useMemo<MapLayerGroup | null>(() => {
    if (!hasContext) return null;
    if (isTransitCategory) {
      if (!transitStops?.length) return null;
      const transitGroup: MapLayerGroup = {
        sources: { [TRANSIT_SOURCE_ID]: { type: "geojson", data: transitGeojson } },
        images: Object.fromEntries(
          transitModes.map((transitMode) => [
            `transit-marker-${transitMode}`,
            (map: MaplibreMap) =>
              void loadTransitMarkerImage(
                map,
                transitMode,
                ownsSource(map, TRANSIT_SOURCE_ID, `transit-marker-${transitMode}`),
              ),
          ]),
        ),
        layers: [
          {
            id: TRANSIT_LAYER_ID,
            type: "symbol",
            source: TRANSIT_SOURCE_ID,
            layout: {
              "icon-image": ["get", "imageId"],
              "icon-allow-overlap": true,
              "icon-ignore-placement": true,
            },
            slot: "route-markers",
            order: 8,
          },
          {
            id: TRANSIT_LABEL_LAYER_ID,
            type: "symbol",
            source: TRANSIT_SOURCE_ID,
            layout: {
              "text-field": ["get", "name"],
              "text-size": 11,
              "text-offset": [0, 2.0],
              "text-anchor": "top",
              "text-max-width": 8,
            },
            paint: {
              "text-color": "#333333",
              "text-halo-color": "#FFFFFF",
              "text-halo-width": 1.5,
            },
            slot: "route-markers",
            order: 9,
          },
        ],
      };
      return transitGroup;
    }
    if (!results?.length) return null;
    const images: NonNullable<MapLayerGroup["images"]> = {};
    for (const imageId of markerImageIds) {
      images[imageId] = (map) =>
        void loadMarkerImage(
          map,
          imageId,
          markerIconPath(imageId),
          ownsSource(map, SOURCE_ID, imageId),
        );
    }
    for (const qid of qids) {
      images[brandImageId(qid)] = (map) => {
        const isCurrent = ownsSource(map, SOURCE_ID, brandImageId(qid));
        void loadBrandMarkerImage(map, qid, isCurrent).then((loaded) => {
          if (loaded && isCurrent()) setBrandLoads((count) => count + 1);
        });
      };
    }
    // The selected result is drawn by the place pin instead, and the hovered
    // result keeps its marker under the hover pin while only its name fades:
    // opacity rather than a filter keeps the symbol placed, so it still answers
    // hover queries and the neighbouring labels do not reshuffle.
    const layers: SlottedLayer[] = resultMarkerLayers(SOURCE_ID, LAYER_ID, LABEL_LAYER_ID).map(
      (layer, index) => ({
        ...layer,
        slot: "route-markers",
        order: 6 + index,
        filter: focusFilter,
        ...(layer.id === LABEL_LAYER_ID
          ? { paint: { ...layer.paint, "text-opacity": hoverLabelOpacity } }
          : {}),
      }),
    );
    return { sources: { [SOURCE_ID]: { type: "geojson", data: categoryData } }, images, layers };
  }, [
    hasContext,
    isTransitCategory,
    transitStops,
    transitGeojson,
    transitModes,
    results,
    markerImageIds,
    qids,
    focusFilter,
    hoverLabelOpacity,
    categoryData,
    ownsSource,
  ]);
  useEffect(() => {
    wantedImages.current = new Set(Object.keys(group?.images ?? {}));
  }, [group]);
  useMapLayerGroup(group);

  useMapOverlayInteraction({
    id: "category-results",
    layerIds: [LAYER_ID, LABEL_LAYER_ID],
    priority: RESULT_INTERACTION_PRIORITY,
    onClick: ({ features }) => {
      const id = features[0]?.properties?.id;
      const place = results?.find((result) => result.id === id);
      if (place) selectResult(place);
    },
    onHover: (features, event) => {
      const id = features?.find((feature) => feature.properties?.id)?.properties?.id;
      if (typeof id === "string") {
        setHoveredCategoryPlaceId(id);
        return;
      }
      const map = mapRef.current;
      if (map && overHoverPin(map, event, hoveredPlace)) return;
      setHoveredCategoryPlaceId(null);
    },
  });

  useMapOverlayInteraction({
    id: "category-transit-stops",
    layerIds: [TRANSIT_LAYER_ID],
    priority: RESULT_INTERACTION_PRIORITY,
    onClick: ({ features }) => {
      const props = features[0].properties as {
        id: string;
        name: string;
        lat: number;
        lng: number;
        modes: string;
        provider: string;
        platformCode: string;
        parentStationId: string;
      };
      const stop: TransitStop = {
        id: props.id,
        name: props.name,
        lat: Number(props.lat),
        lng: Number(props.lng),
        modes: JSON.parse(props.modes) as TransportMode[],
        provider: props.provider,
        platformCode: props.platformCode || undefined,
        parentStationId: props.parentStationId || undefined,
        contributors: readCapturedContributors(features[0].properties?._recordContributors) ?? [],
        fieldContributors: readCapturedFieldContributors(
          features[0].properties?._fieldContributors,
        ),
      };
      flyTo([stop.lng, stop.lat], 16);
      selectWithEnrichment(makeSyntheticStopPlace(stop), () => resolveStopAsPlace(stop));
      useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
    },
  });

  return null;
}
