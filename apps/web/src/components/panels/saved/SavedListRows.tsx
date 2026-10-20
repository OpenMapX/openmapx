"use client";

import Box from "@mui/material/Box";
import {
  type CategoryPlace,
  directPlaceDetailsId,
  type Place,
  presentOpeningHoursInfo,
  resolveDistanceReference,
  type SavedPlace,
  useMapStore,
  useOpeningHoursClock,
  usePlaceDetails,
  useReverseGeocoding,
} from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { captureFieldContributors } from "@openmapx/mobility-core/contributors";
import { onlineManager } from "@tanstack/react-query";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { PlaceResultRow } from "@/components/ui/PlaceResultRow";
import { ResultList } from "@/components/ui/ResultListItem";
import { savedPlaceToPlace } from "@/lib/openSavedPlace";

const MAX_CONCURRENT_DETAILS = 3;

function rowPlace(saved: Place, details: Place | null | undefined, now: number): CategoryPlace {
  const fields: Record<string, readonly Attribution[]> = {};
  if (details) {
    for (const field of Object.keys(details)) {
      if (field !== "contributors" && field !== "fieldContributors")
        Object.assign(fields, captureFieldContributors(details, field));
    }
  }
  // Stored values retain their captured owners even when a nearby resolver has a different title.
  for (const field of ["name", "coordinates", ...(saved.address ? ["address"] : [])]) {
    for (const key of Object.keys(fields)) {
      if (key === field || key.startsWith(`${field}.`)) delete fields[key];
    }
    for (const [key, value] of Object.entries(saved.fieldContributors ?? {})) {
      if (key === field || key.startsWith(`${field}.`)) fields[key] = value;
    }
  }
  return {
    ...details,
    id: saved.id,
    name: saved.name,
    coordinates: saved.coordinates,
    address: saved.address || details?.address,
    openingHoursInfo: presentOpeningHoursInfo(
      details?.openingHoursInfo,
      details?.openingHours,
      now,
    ),
    fieldContributors: fields,
  };
}

export function SavedListRows({
  places,
  onSelect,
  renderNote,
}: {
  places: SavedPlace[];
  onSelect: (place: SavedPlace) => void;
  renderNote: (place: SavedPlace) => ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [nearby, setNearby] = useState<Set<string>>(() => new Set());
  const [settled, setSettled] = useState<Map<string, Place | null | undefined>>(() => new Map());
  const online = useSyncExternalStore(
    onlineManager.subscribe,
    () => onlineManager.isOnline(),
    () => true,
  );
  const now = useOpeningHoursClock();
  useEffect(() => {
    // Undefined marks paused acquisition; retry it on reconnect without polling completed rows.
    if (online)
      setSettled((previous) => new Map([...previous].filter(([, value]) => value !== undefined)));
  }, [online]);
  const userLocation = useMapStore((s) => s.userLocation);
  const distanceReference = resolveDistanceReference({
    anchor: null,
    searchBbox: null,
    userLocation,
  });
  const rows = useMemo(
    () =>
      places.map((saved) => {
        const place = savedPlaceToPlace(saved);
        return {
          saved,
          place,
          key: JSON.stringify([place.id, place.coordinates, place.name, Boolean(place.address)]),
        };
      }),
    [places],
  );

  useEffect(() => {
    if (rows.length === 0 || !root.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        setNearby((previous) => {
          const next = new Set(previous);
          for (const entry of entries) {
            const key = (entry.target as HTMLElement).dataset.savedPlaceKey;
            if (key) {
              if (entry.isIntersecting) next.add(key);
              else next.delete(key);
            }
          }
          return next;
        });
      },
      { rootMargin: "120px 0px" },
    );
    for (const row of root.current.querySelectorAll("[data-saved-place-key]"))
      observer.observe(row);
    return () => observer.disconnect();
  }, [rows]);

  const complete = useCallback((key: string, place: Place | null | undefined) => {
    setSettled((previous) => new Map(previous).set(key, place));
  }, []);
  const active = rows
    .filter((row) => nearby.has(row.key) && !settled.has(row.key))
    .slice(0, MAX_CONCURRENT_DETAILS);
  return (
    <Box ref={root}>
      {active.map((row) => (
        <SavedPlaceResolver
          key={row.key}
          place={row.place}
          identity={row.key}
          onComplete={complete}
        />
      ))}
      <ResultList
        items={rows}
        getKey={(row) => row.saved.id}
        renderItem={(row) => {
          const details = settled.get(row.key);
          const place = rowPlace(row.place, details, now);
          const summary = details?.photos?.[0]
            ? { id: place.id, photo: details.photos[0] }
            : undefined;
          return (
            <Box
              key={row.saved.id}
              data-saved-place-id={row.saved.id}
              data-saved-place-key={row.key}
            >
              <PlaceResultRow
                place={place}
                summary={summary}
                onSelect={() => onSelect(row.saved)}
                distanceReference={distanceReference}
                loading={online && nearby.has(row.key) && !settled.has(row.key)}
                footer={renderNote(row.saved)}
              />
            </Box>
          );
        }}
      />
    </Box>
  );
}

function SavedPlaceResolver({
  place,
  identity,
  onComplete,
}: {
  place: Place;
  identity: string;
  onComplete: (key: string, place: Place | null | undefined) => void;
}) {
  // Match useMergedPlace's inputs so opening the card reuses this query.
  const detailsId = directPlaceDetailsId(place, false);
  const details = usePlaceDetails(
    detailsId,
    place.coordinates,
    place.name,
    undefined,
    Boolean(place.address),
  );
  const reverse = useReverseGeocoding(
    place.primaryScheme === "coordinate" ? place.coordinates : null,
  );
  const query = detailsId === null ? reverse : details;
  useEffect(() => {
    if (query.isFetching) return;
    if (query.data !== undefined || query.isError) {
      const resolved =
        detailsId === null
          ? reverse.data
            ? {
                ...place,
                address: reverse.data.address ?? "",
                city: reverse.data.city,
                fieldContributors: captureFieldContributors(reverse.data, "address"),
              }
            : null
          : (details.data ?? null);
      onComplete(identity, resolved);
    } else if (query.isPaused) onComplete(identity, undefined);
  }, [
    query.data,
    query.isError,
    query.isFetching,
    query.isPaused,
    detailsId,
    reverse.data,
    details.data,
    place,
    identity,
    onComplete,
  ]);
  return null;
}
