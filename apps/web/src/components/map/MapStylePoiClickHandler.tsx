"use client";

import useMediaQuery from "@mui/material/useMediaQuery";
import type { Place } from "@openmapx/core";
import {
  categoryPlaceToPlace,
  createPlace,
  PANEL,
  useDirectionsStore,
  useIsSaved,
  usePlaceDetails,
  usePlaceStore,
  useSession,
  useSidebarStore,
} from "@openmapx/core";
import type { MapMouseEvent } from "maplibre-gl";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AuthDialog } from "@/components/auth/AuthDialog";
import { SavePlaceDialog } from "@/components/panels/saved/SavePlaceDialog";
import { INTERACTIVE_LAYER_IDS } from "@/integration-api/map/interactiveLayers";
import { useMap } from "@/integration-api/map/MapContext";
import { getMapClickOwner } from "@/integration-api/map/mapClickOwnership";
import { useMapObstructionInsets } from "@/lib/mapObstructions";
import { findStylePoiAtPoint, getStylePoiLayerIds, type StylePoiTarget } from "./mapStylePoiTarget";
import { StylePoiHoverCard } from "./StylePoiHoverCard";
import { hoverCardPlacement } from "./stylePoiHoverPlacement";

/** Hover previews need a pointer that can rest on a POI without pressing it. */
const FINE_POINTER = "(hover: hover) and (pointer: fine)";
/** How long the pointer rests on a POI before its card appears. */
const SHOW_DELAY_MS = 120;
/**
 * How much longer it must rest before the place is looked up. Sweeping the
 * pointer across the map shows cards from the tile alone; only a pause costs a
 * (rate-limited) lookup — the same one a click makes, so a hover that turns
 * into a click opens the panel from cache.
 */
const LOOKUP_DELAY_MS = 180;
/** Time to cross the gap from the icon into its card before the card closes. */
const HIDE_GRACE_MS = 150;

/**
 * The place a basemap POI stands for: the name the map prints, its tile
 * feature id, and the tile's class. Clicking the POI and its hover card both
 * open exactly this place, so they share one place lookup.
 */
export function stylePoiPlace(target: StylePoiTarget): Place {
  if (target.canonicalPlace) return categoryPlaceToPlace(target.canonicalPlace);
  return createPlace({
    primaryScheme: "stylePoi",
    ids: { stylePoi: target.featureId },
    name: target.name,
    address: target.name,
    coordinates: target.coordinates,
    category: target.category,
    rawCategory: target.rawCategory,
  });
}

function openPlace(place: Place, setSelectedPlace: (place: Place) => void) {
  setSelectedPlace(place);
  const sidebarId = useSidebarStore.getState().activeSidebarId;
  if (!sidebarId || sidebarId === PANEL.PLACE) {
    // Sidebar is empty or already showing a place — take it over and close any
    // floating card so we don't show the same place in two panels at once.
    useSidebarStore.getState().closeDetail();
    useSidebarStore.getState().openSidebar(PANEL.PLACE);
  } else {
    // Another panel (category results, data source, directions …) is active —
    // keep it and show just the floating detail card.
    useSidebarStore.getState().openDetail(PANEL.PLACE_CARD);
  }
}

interface HoveredPoi {
  target: StylePoiTarget;
  place: Place;
  /** The POI's position in map-container pixels when the card opened. */
  point: { x: number; y: number };
}

/**
 * Makes the map style's built-in POI symbols (restaurants, hotels, hospitals,
 * parks, etc.) clickable. Clicking a named POI opens the place details panel
 * via the same flow as search results — name + coordinate lookup against
 * Nominatim, followed by knowledge lookup. With a mouse, resting on a POI
 * previews it in a card first.
 */
export function MapStylePoiClickHandler() {
  const { mapRef, mapReady, styleVersion } = useMap();
  const { setSelectedPlace } = usePlaceStore();
  const locale = useLocale();
  const poiLayerIdsRef = useRef<string[]>([]);
  const finePointer = useMediaQuery(FINE_POINTER, { noSsr: true });
  const insets = useMapObstructionInsets();

  const [hovered, setHovered] = useState<HoveredPoi | null>(null);
  const [lookupReady, setLookupReady] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [authOpen, setAuthOpen] = useState(false);
  const [savePlace, setSavePlace] = useState<Place | null>(null);
  const candidateRef = useRef<string | null>(null);
  const overCardRef = useRef(false);
  const cardShownRef = useRef(false);
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lookupTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    for (const timer of [showTimerRef, hideTimerRef, lookupTimerRef]) {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  const dismiss = useCallback(() => {
    clearTimers();
    candidateRef.current = null;
    overCardRef.current = false;
    cardShownRef.current = false;
    setHovered(null);
    setLookupReady(false);
  }, [clearTimers]);

  // Discover POI layers from the style and keep the shared interactive-layer
  // registry in sync so MapClickHandler doesn't clear the selection on click.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    let registeredIds: string[] = [];

    const syncLayers = () => {
      // getStyle() returns null/undefined while style is still loading
      const ids = getStylePoiLayerIds(map);
      if (ids.length === 0 && registeredIds.length === 0) return;

      for (const id of registeredIds) {
        if (!ids.includes(id)) INTERACTIVE_LAYER_IDS.delete(id);
      }
      for (const id of ids) INTERACTIVE_LAYER_IDS.add(id);

      registeredIds = ids;
      poiLayerIdsRef.current = ids;
    };

    // "load" fires when the style is fully ready; "styledata" covers subsequent
    // layer changes (e.g. satellite toggle). We try immediately as well in case
    // the style was already loaded before this effect ran.
    syncLayers();
    map.on("load", syncLayers);
    map.on("styledata", syncLayers);

    return () => {
      map.off("load", syncLayers);
      map.off("styledata", syncLayers);
      for (const id of registeredIds) INTERACTIVE_LAYER_IDS.delete(id);
      poiLayerIdsRef.current = [];
    };
  }, [mapRef, mapReady, styleVersion]);

  // Click handler: open the place details panel for the topmost named POI.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const onClick = (e: MapMouseEvent) => {
      if (getMapClickOwner(e)) return;
      const target = findStylePoiAtPoint(
        map,
        e.point,
        poiLayerIdsRef.current,
        INTERACTIVE_LAYER_IDS,
        locale,
      );
      if (!target) return;
      openPlace(stylePoiPlace(target), setSelectedPlace);
    };

    map.on("click", onClick);
    return () => {
      map.off("click", onClick);
    };
  }, [mapRef, mapReady, styleVersion, setSelectedPlace, locale]);

  // Pointer: a pointer cursor over any named style POI and, with a mouse, the
  // hover card after a short rest.
  useEffect(() => {
    void styleVersion;
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const show = (target: StylePoiTarget) => {
      cardShownRef.current = true;
      const point = map.project(target.coordinates);
      setHovered({ target, place: stylePoiPlace(target), point: { x: point.x, y: point.y } });
      setLookupReady(false);
      if (lookupTimerRef.current) clearTimeout(lookupTimerRef.current);
      lookupTimerRef.current = setTimeout(() => setLookupReady(true), LOOKUP_DELAY_MS);
    };

    const scheduleHide = () => {
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        if (!overCardRef.current && candidateRef.current === null) dismiss();
      }, HIDE_GRACE_MS);
    };

    const onMouseMove = (e: MapMouseEvent) => {
      const target = findStylePoiAtPoint(
        map,
        e.point,
        poiLayerIdsRef.current,
        INTERACTIVE_LAYER_IDS,
        locale,
      );
      map.getCanvasContainer().style.cursor = target ? "pointer" : "";
      if (!finePointer) return;
      // A held button means a drag is starting, which moves the POI away.
      if (e.originalEvent.buttons !== 0) {
        dismiss();
        return;
      }
      const key = target?.featureId ?? null;
      if (key === candidateRef.current) return;
      candidateRef.current = key;
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
      if (!target) {
        scheduleHide();
        return;
      }
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
      // While a card is up, moving to the next POI switches it at once.
      if (cardShownRef.current) show(target);
      else showTimerRef.current = setTimeout(() => show(target), SHOW_DELAY_MS);
    };

    const onMouseOut = () => {
      map.getCanvasContainer().style.cursor = "";
      candidateRef.current = null;
      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
      scheduleHide();
    };

    map.on("mousemove", onMouseMove);
    map.on("mouseout", onMouseOut);
    // The card marks a spot on the map; once the map moves, it would point at
    // the wrong place.
    map.on("movestart", dismiss);
    map.on("mousedown", dismiss);
    map.on("wheel", dismiss);
    map.on("click", dismiss);
    return () => {
      map.off("mousemove", onMouseMove);
      map.off("mouseout", onMouseOut);
      map.off("movestart", dismiss);
      map.off("mousedown", dismiss);
      map.off("wheel", dismiss);
      map.off("click", dismiss);
      dismiss();
    };
  }, [mapRef, mapReady, styleVersion, locale, finePointer, dismiss]);

  useEffect(() => clearTimers, [clearTimers]);

  // Exactly the lookup the place panel makes for this POI (see useMergedPlace),
  // so its cache entry serves the panel when the hover turns into a click.
  const hoveredPlace = hovered?.place ?? null;
  const { data: details, isFetching } = usePlaceDetails(
    lookupReady && hoveredPlace ? hoveredPlace.id : null,
    hoveredPlace?.coordinates,
    hoveredPlace?.name,
    undefined,
    true,
  );
  const { data: session } = useSession();
  const { data: savedInListIds } = useIsSaved(
    session?.user && hoveredPlace ? hoveredPlace.id : null,
  );

  const map = mapRef.current;
  const container = map?.getContainer();
  let card: React.ReactNode = null;
  if (hovered && hoveredPlace && container) {
    const rect = container.getBoundingClientRect();
    const placement = hoverCardPlacement({
      point: hovered.point,
      mapSize: { width: rect.width, height: rect.height },
      insets,
    });
    // The card is fixed to the viewport (portalled to <body>) so pointer events
    // over it never reach the map, which would read them as map clicks.
    const viewportPlacement = {
      ...placement,
      left: placement.left + rect.left,
      top: placement.top === undefined ? undefined : placement.top + rect.top,
      bottom:
        placement.bottom === undefined
          ? undefined
          : placement.bottom + (window.innerHeight - rect.bottom),
    };
    // Keep the clicked POI's identity, as the panel does, with the looked-up
    // details beside it.
    const fullPlace: Place = details
      ? {
          ...details,
          id: hoveredPlace.id,
          primaryScheme: hoveredPlace.primaryScheme,
          ids: { ...(details.ids ?? {}), ...hoveredPlace.ids },
        }
      : hoveredPlace;
    card = createPortal(
      <StylePoiHoverCard
        key={hoveredPlace.id}
        name={hovered.target.name}
        details={details}
        loading={!details && (isFetching || !lookupReady)}
        placement={viewportPlacement}
        saved={Boolean(savedInListIds && savedInListIds.length > 0)}
        onPointerEnter={() => {
          overCardRef.current = true;
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          hideTimerRef.current = null;
        }}
        onPointerLeave={() => {
          overCardRef.current = false;
          if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
          hideTimerRef.current = setTimeout(() => {
            if (!overCardRef.current && candidateRef.current === null) dismiss();
          }, HIDE_GRACE_MS);
        }}
        onOpen={() => {
          dismiss();
          openPlace(hoveredPlace, setSelectedPlace);
        }}
        onDirections={() => {
          dismiss();
          const directions = useDirectionsStore.getState();
          directions.setWaypoint(
            directions.waypoints.length - 1,
            hoveredPlace.coordinates,
            hoveredPlace.name,
          );
          directions.open();
          useSidebarStore.getState().openSidebar(PANEL.DIRECTIONS);
        }}
        onSave={() => {
          dismiss();
          setSavePlace(fullPlace);
          if (session?.user) setSaveOpen(true);
          else setAuthOpen(true);
        }}
      />,
      document.body,
    );
  }

  return (
    <>
      {card}
      {savePlace && (
        <SavePlaceDialog open={saveOpen} onClose={() => setSaveOpen(false)} place={savePlace} />
      )}
      <AuthDialog open={authOpen} onClose={() => setAuthOpen(false)} />
    </>
  );
}
