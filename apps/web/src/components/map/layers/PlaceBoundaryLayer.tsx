"use client";

import type { AreaGeometry, BBox } from "@openmapx/core";
import { usePlaceDetails, usePlaceStore } from "@openmapx/core";
import type maplibregl from "maplibre-gl";
import { useEffect, useRef } from "react";
import { useMap } from "@/lib/MapContext";
import { getFirstSymbolLayerId } from "./layerStyleUtils";

type GeoJSONSource = maplibregl.GeoJSONSource;

const SOURCE_ID = "place-boundary-source";
const LAYER_FILL = "place-boundary-fill";
const LAYER_LINE = "place-boundary-line";

// Google-style muted red for the administrative boundary outline.
const BOUNDARY_COLOR = "#A52714";

const EMPTY: GeoJSON.FeatureCollection = { type: "FeatureCollection", features: [] };

/** Derive a [west, south, east, north] extent from a Polygon/MultiPolygon. */
function bboxFromGeometry(geometry: AreaGeometry): BBox {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  const rings = geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat();
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < west) west = lng;
      if (lng > east) east = lng;
      if (lat < south) south = lat;
      if (lat > north) north = lat;
    }
  }
  return [west, south, east, north];
}

/**
 * Draws the administrative-boundary outline of the selected place (city,
 * region, country) as a dashed red border with a faint fill, and fits the map
 * to the whole area once per selection — mirroring Google Maps' city highlight.
 *
 * The boundary geometry is supplied by `/api/places/:id` (see the server's
 * `enrichPlace`). We re-read it through `usePlaceDetails` with the same query
 * key the place panel uses, so React Query dedupes it to a single request.
 */
export function PlaceBoundaryLayer() {
  const { mapRef, mapReady, styleVersion, fitBounds, flyTo } = useMap();
  const selectedPlace = usePlaceStore((s) => s.selectedPlace);

  // SearchBar suppresses its fixed-zoom fly for area results (`type: "region"`,
  // carried onto the place as `category`) and defers camera framing to us.
  const isAreaSelection = selectedPlace?.category === "region";
  const selectedCoords = selectedPlace?.coordinates ?? null;

  // Mirror useMergedPlace's lookup args so the query key matches and React
  // Query serves the panel's already-fetched detail from cache.
  const isCoordinatePlace = selectedPlace?.primaryScheme === "coordinate";
  const placeDetailsId = isCoordinatePlace ? null : (selectedPlace?.id ?? null);
  const { data } = usePlaceDetails(
    placeDetailsId,
    selectedPlace?.coordinates,
    selectedPlace?.name,
    undefined,
    Boolean(selectedPlace?.address),
  );

  const boundary = data?.boundary ?? null;
  const boundingBox = data?.boundingBox ?? null;
  const lastFittedId = useRef<string | null>(null);

  // Add source + layers (once per style load).
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const setup = () => {
      if (!map.isStyleLoaded()) {
        map.once("idle", setup);
        return;
      }
      if (map.getSource(SOURCE_ID)) return;
      map.addSource(SOURCE_ID, { type: "geojson", data: EMPTY });

      // Insert below the first symbol layer so place labels stay legible.
      const beforeId = getFirstSymbolLayerId(map);
      map.addLayer(
        {
          id: LAYER_FILL,
          type: "fill",
          source: SOURCE_ID,
          paint: { "fill-color": BOUNDARY_COLOR, "fill-opacity": 0.05 },
        },
        beforeId,
      );
      map.addLayer(
        {
          id: LAYER_LINE,
          type: "line",
          source: SOURCE_ID,
          layout: { "line-join": "round", "line-cap": "round" },
          paint: {
            "line-color": BOUNDARY_COLOR,
            "line-width": 2.5,
            "line-opacity": 0.9,
            "line-dasharray": [1.5, 2],
          },
        },
        beforeId,
      );
    };

    // Re-add after a style/theme swap (which wipes all sources): `styledata`
    // re-fires on each style load and the in-setup `once("idle")` covers the
    // mid-load case, whereas `once("load")` fires only once — so the boundary
    // would vanish on a theme change.
    setup();
    map.on("styledata", setup);
    return () => {
      map.off("styledata", setup);
    };
  }, [mapRef, mapReady, styleVersion]);

  // Sync the boundary geometry into the source whenever the selection changes.
  useEffect(() => {
    const map = mapRef.current;
    const raw = map?.getSource(SOURCE_ID);
    if (!raw || raw.type !== "geojson") return;
    const source = raw as GeoJSONSource;

    if (!boundary) {
      source.setData(EMPTY);
      // Area selection whose admin boundary couldn't be fetched: SearchBar
      // skipped its fly, so move the camera here once so the search still lands.
      if (data && isAreaSelection && selectedCoords && placeDetailsId) {
        if (lastFittedId.current !== placeDetailsId) {
          lastFittedId.current = placeDetailsId;
          flyTo(selectedCoords, 11);
        }
      }
      return;
    }

    source.setData({
      type: "FeatureCollection",
      features: [{ type: "Feature", properties: {}, geometry: boundary }],
    });

    // Fit to the area once per selection (don't fight subsequent user panning).
    const fitId = placeDetailsId;
    if (fitId && lastFittedId.current !== fitId) {
      lastFittedId.current = fitId;
      const [west, south, east, north] = boundingBox ?? bboxFromGeometry(boundary);
      fitBounds(
        [
          [west, south],
          [east, north],
        ],
        60,
      );
    }
  }, [
    boundary,
    boundingBox,
    placeDetailsId,
    data,
    isAreaSelection,
    selectedCoords,
    mapRef,
    fitBounds,
    flyTo,
  ]);

  return null;
}
