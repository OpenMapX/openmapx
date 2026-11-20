import type { AutocompleteResult, LngLat } from "@openmapx/core";
import { useAutocomplete, useDebounce, useDirectionsStore, useMapStore } from "@openmapx/core";
import { useLocale, useTranslations } from "next-intl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { useWaypointDrafts } from "@/components/panels/directions/useWaypointDrafts";
import { waypointPlaceholder } from "@/components/panels/directions/WaypointList";
import { useMapOptional } from "@/integration-api/map/MapContext";
import { useForegroundLocation } from "@/lib/mobile/useForegroundLocation";
import { useStopSearchStore } from "@/stores/stopSearchStore";

/**
 * The directions panel's stop fields: typed drafts, focus, the suggestions
 * for the focused field, filling the origin from a fresh location fix, and
 * the stop whose schedule is being edited.
 */
export function useWaypointFields() {
  const t = useTranslations("directions");
  const locale = useLocale();
  const { isOpen, waypoints, setWaypoint, removeWaypoint } = useDirectionsStore(
    useShallow((s) => ({
      isOpen: s.isOpen,
      waypoints: s.waypoints,
      setWaypoint: s.setWaypoint,
      removeWaypoint: s.removeWaypoint,
    })),
  );
  const userLocation = useMapStore((s) => s.userLocation);
  const mapContext = useMapOptional();
  const [focusedField, setFocusedField] = useState<number | null>(null);
  const [scheduleEditIndex, setScheduleEditIndex] = useState<number | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { values: inputValues, setDraft, clearDraft, hasDraft } = useWaypointDrafts(waypoints);
  const blurTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelBlur = useCallback(() => {
    if (blurTimeoutRef.current !== null) clearTimeout(blurTimeoutRef.current);
    blurTimeoutRef.current = null;
  }, []);
  useEffect(() => cancelBlur, [cancelBlur]);

  const myLocationLabel = t("myLocation");
  const requestFix = useForegroundLocation();
  // A fix that arrived while the origin held typed text. If that text is
  // emptied the fix still answers where the person is, so it fills the origin
  // then.
  const withheldFix = useRef<{ originId: string; location: LngLat } | null>(null);
  useEffect(() => {
    withheldFix.current = null;
    if (!isOpen) return;
    const requestedOrigin = useDirectionsStore.getState().waypoints[0];
    if (!requestedOrigin || requestedOrigin.coords !== null) return;

    let active = true;
    // Through the adapter, so the installed shell answers from the one location
    // producer it already owns rather than opening a second one.
    void requestFix({ maxAgeMs: 0 }).then((result) => {
      if (!active || result.status !== "ok") return;
      const directions = useDirectionsStore.getState();
      const origin = directions.waypoints[0];
      if (!directions.isOpen || origin?.id !== requestedOrigin.id || origin.coords !== null) return;
      const location: LngLat = [result.fix.lng, result.fix.lat];
      useMapStore.getState().setUserLocation(location);
      // Text being typed into the origin is the person's own choice of start.
      if (hasDraft(origin.id)) {
        withheldFix.current = { originId: origin.id, location };
        return;
      }
      setWaypoint(0, location, myLocationLabel);
    });

    return () => {
      active = false;
    };
  }, [isOpen, myLocationLabel, setWaypoint, requestFix, hasDraft]);

  // Autocomplete for the currently focused waypoint input
  const activeQuery = focusedField !== null ? (inputValues[focusedField] ?? "") : "";
  const debouncedActiveQuery = useDebounce(activeQuery, 300);
  // Rank suggestions near the visible map. A cheap ref read each render; the
  // hook rounds the point, so small pans keep the same query key.
  const suggestionMap = mapContext?.mapRef.current;
  const suggestionCenter = suggestionMap?.getCenter();
  const suggestionBias =
    suggestionMap && suggestionCenter
      ? {
          proximity: [suggestionCenter.lng, suggestionCenter.lat] as LngLat,
          zoom: suggestionMap.getZoom(),
        }
      : null;
  const { data: suggestions } = useAutocomplete(debouncedActiveQuery, locale, suggestionBias);

  const fillMyLocation = useCallback(() => {
    if (!userLocation) return;
    const origin = waypoints[0];
    if (origin) clearDraft(origin.id);
    setWaypoint(0, userLocation, myLocationLabel);
  }, [userLocation, waypoints, clearDraft, setWaypoint, myLocationLabel]);

  // The dropdown must outlive the blur long enough for a click on a suggestion,
  // but a pending blur belongs to the field that fired it, not the next one.
  const onBlur = useCallback(() => {
    cancelBlur();
    blurTimeoutRef.current = setTimeout(() => {
      blurTimeoutRef.current = null;
      setFocusedField(null);
    }, 150);
  }, [cancelBlur]);

  // On a phone the stop card opens a full-screen search; on desktop the
  // suggestions open under the field.
  const onFocus = useCallback(
    (index: number) => {
      cancelBlur();
      setFocusedField(index);
    },
    [cancelBlur],
  );

  const onInputChange = useCallback(
    (index: number, value: string) => {
      const waypoint = waypoints[index];
      if (!waypoint) return;
      const withheld = withheldFix.current;
      if (value.trim() === "" && withheld?.originId === waypoint.id && waypoint.coords === null) {
        withheldFix.current = null;
        clearDraft(waypoint.id);
        setWaypoint(index, withheld.location, myLocationLabel);
        return;
      }
      if (value) {
        setDraft(waypoint, value);
        return;
      }
      clearDraft(waypoint.id);
      setWaypoint(index, null, "");
    },
    [waypoints, setDraft, clearDraft, setWaypoint, myLocationLabel],
  );

  const selectSuggestion = (result: AutocompleteResult) => {
    if (!result.coordinates || focusedField === null) return;
    const { label, coordinates } = result;
    const waypoint = waypoints[focusedField];
    if (waypoint) clearDraft(waypoint.id);
    setWaypoint(focusedField, coordinates, label);
    cancelBlur();
    setFocusedField(null);
  };

  const onRemove = useCallback(
    (index: number) => {
      const waypoint = waypoints[index];
      if (waypoint) clearDraft(waypoint.id);
      removeWaypoint(index);
    },
    [waypoints, clearDraft, removeWaypoint],
  );

  const focusWaypoint = (index: number) => {
    listRef.current?.querySelectorAll("input")[index]?.focus();
  };

  // A phone chooses a stop in the main full-screen search, as a search
  // that fills the stop instead of opening the place.
  const openStopSearch = (index: number) => {
    const waypoint = waypoints[index];
    if (!waypoint) return;
    useStopSearchStore.getState().open({
      initialQuery: inputValues[index] ?? "",
      placeholder: waypointPlaceholder(t, index, waypoints.length),
      onPick: ({ coordinates, label }) => {
        clearDraft(waypoint.id);
        setWaypoint(index, coordinates, label);
      },
    });
  };

  return {
    listRef,
    inputValues,
    onInputChange,
    onFocus,
    onBlur,
    onRemove,
    onUseMyLocation: userLocation ? fillMyLocation : undefined,
    focusWaypoint,
    openStopSearch,
    suggestions: suggestions ?? [],
    suggestionQuery: activeQuery,
    showSuggestions: focusedField !== null && (suggestions?.length ?? 0) > 0,
    selectSuggestion,
    userLocation,
    scheduleEditIndex,
    editSchedule: setScheduleEditIndex,
  };
}
