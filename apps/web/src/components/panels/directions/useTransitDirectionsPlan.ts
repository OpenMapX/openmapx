"use client";

import type { DirectionsState } from "@openmapx/core";
import {
  buildTransitPlanParams,
  type TransitPlanQuery,
  transitItineraryKey,
  transitPlanQueryKey,
  useDirectionsStore,
  useTransitChainPlan,
  useTransitPlan,
} from "@openmapx/core";
import { contributorsForRecords } from "@openmapx/mobility-core/contributors";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { useEffect, useRef, useState } from "react";
import {
  findTransitItinerary,
  mergeTransitItineraryPage,
  sameTransitItinerary,
  selectTransitAlternative,
} from "./transitPlanPages";
import { useTransitPlanRequest } from "./useTransitPlanRequest";

export type TransitDirectionsSnapshot = Pick<
  DirectionsState,
  | "waypoints"
  | "transitDepartureTime"
  | "transitArrivalTime"
  | "transitPreferredModes"
  | "transitRoutePreference"
  | "transitAccessMode"
  | "wheelchairRequired"
  | "maxTransfers"
  | "transferBuffer"
  | "requireBikeTransport"
  | "bikeHillPreference"
  | "deutschlandticketOnly"
> & { enabled: boolean; timeMode: "now" | "depart" | "arrive" };

/** Paging state owned by exactly one routing query; a different query never inherits it. */
interface TransitPagingOwner {
  identity: string;
  token?: string;
  direction: "previous" | "next";
}

/** Raw (undebounced) value of the time the active mode edits, so edits retire paging at once. */
function rawTimeIdentity(value: "now" | Date | null): string | number | null {
  return value instanceof Date ? value.getTime() : value;
}

export type TransitDirectionsPlan = ReturnType<typeof useTransitDirectionsPlan>;

/** Composes existing transit acquisition, page publication and captured navigation policy. */
export function useTransitDirectionsPlan(snapshot: TransitDirectionsSnapshot) {
  const { enabled, timeMode, transitDepartureTime, transitArrivalTime, transitRoutePreference } =
    snapshot;
  const reference = useDirectionsStore((s) => s.transitReference);
  const pending = useDirectionsStore((s) => s.pendingTransitSelection);
  const [selectionToOpen, setSelectionToOpen] = useState<{
    index: number;
    itineraryKey: string;
    itinerary: TripItinerary;
    queryIdentity: string;
  } | null>(null);
  const lastPublication = useRef<{ data: unknown; identity: string } | null>(null);
  const itineraries = useDirectionsStore((s) => s.transitItineraries);
  const request = useTransitPlanRequest(snapshot);
  const { origin, destination, planArgs } = request;
  const transitDepartAtStr = request.departAt;
  const transitArriveByStr = request.arriveBy;
  const transitIsChained = request.isChained;
  const transitChainQuery = useTransitChainPlan(request.chainRequest);

  const planningActive = enabled && !transitIsChained && origin !== null && destination !== null;

  // Page tokens are signed against the query that issued them, so paging belongs
  // to that query's canonical request. The serializer collapses equivalent
  // coordinates and option lists; an implicit time is a marker because the hook
  // owns the actual minute it anchors to.
  const pagingIdentity = reference
    ? JSON.stringify(transitPlanQueryKey({ kind: "reference", params: reference }))
    : planningActive && origin && destination
      ? JSON.stringify([
          buildTransitPlanParams({
            origin,
            destination,
            time: transitArriveByStr ?? transitDepartAtStr ?? "now",
            arriveBy: transitArriveByStr !== undefined,
            ...planArgs,
          }),
          timeMode,
          rawTimeIdentity(
            timeMode === "depart"
              ? transitDepartureTime
              : timeMode === "arrive"
                ? transitArrivalTime
                : null,
          ),
        ])
      : "inactive";
  const [storedPaging, setStoredPaging] = useState<TransitPagingOwner>({
    identity: pagingIdentity,
    direction: "next",
  });
  // Retire a previous query's paging synchronously: an effect would first let one
  // render and request pair the changed inputs with the old token.
  let paging = storedPaging;
  if (storedPaging.identity !== pagingIdentity) {
    paging = { identity: pagingIdentity, direction: "next" };
    setStoredPaging(paging);
  }
  const transitPageToken = paging.token;
  const transitPageDirection = paging.direction;
  const loadPage = (direction: "previous" | "next", token: string | undefined) => {
    if (!planningActive || reference || !token) return;
    // Only the rendered owner may advance; callbacks from an earlier query or page no-op.
    setStoredPaging((current) =>
      current === paging ? { identity: paging.identity, token, direction } : current,
    );
  };

  const queryForTime = (time: string, arriveBy: boolean): TransitPlanQuery | null =>
    reference
      ? { kind: "reference", params: reference }
      : origin && destination
        ? {
            kind: "search",
            params: {
              origin,
              destination,
              time,
              arriveBy,
              ...planArgs,
              pageToken: transitPageToken,
            },
          }
        : null;
  const currentQuery = queryForTime(
    transitArriveByStr ?? transitDepartAtStr ?? "now",
    Boolean(transitArriveByStr),
  );
  const rawTime =
    timeMode === "arrive"
      ? transitArrivalTime
      : timeMode === "depart"
        ? transitDepartureTime
        : null;
  const rawQuery = queryForTime(
    rawTime instanceof Date ? rawTime.toISOString() : "now",
    timeMode === "arrive" && rawTime instanceof Date,
  );
  const currentKey = currentQuery ? JSON.stringify(transitPlanQueryKey(currentQuery)) : "inactive";
  const rawKey = rawQuery ? JSON.stringify(transitPlanQueryKey(rawQuery)) : "inactive";
  const waitingForSelection = Boolean(pending && currentKey !== pending.requestKey);

  const transitPlanQuery = useTransitPlan({
    enabled: !waitingForSelection,
    reference,
    origin: enabled && !transitIsChained ? origin : null,
    destination: enabled && !transitIsChained ? destination : null,
    departAt: transitDepartAtStr,
    arriveBy: transitArriveByStr,
    ...planArgs,
    pageToken: transitPageToken,
  });
  const { data: transitPlanData } = transitPlanQuery;
  const attributions = contributorsForRecords(itineraries);
  const queryOwner = useRef(pagingIdentity);
  queryOwner.current = pagingIdentity;
  const publishedOwner = useRef<string | null>(null);
  const retainedAlternative = useRef<{ identity: string; itinerary: TripItinerary } | null>(null);
  const selectAlternative = (
    parent: TripItinerary,
    candidate: TripItinerary,
  ): TripItinerary | null => {
    if (queryOwner.current !== pagingIdentity) return null;
    const state = useDirectionsStore.getState();
    if (state.pendingTransitSelection) return null;
    const selected = selectTransitAlternative(state.transitItineraries, parent, candidate);
    if (!selected) return null;
    const itinerary = selected.itineraries[selected.index];
    // The selection's index points into its own itinerary list.
    if (!itinerary) throw new RangeError(`No itinerary at selected index ${selected.index}`);
    retainedAlternative.current = { identity: pagingIdentity, itinerary };
    state.setTransitItineraries(selected.itineraries);
    state.setActiveItineraryIndex(selected.index);
    return itinerary;
  };
  useEffect(() => {
    const store = useDirectionsStore.getState();
    if (pending && rawKey !== pending.requestKey) {
      store.cancelTransitSelection(pending);
      return;
    }
    if (waitingForSelection || !transitPlanData?.itineraries) return;
    const identity = `${currentKey}|${transitRoutePreference}|${transitPageDirection}`;
    if (
      lastPublication.current?.data === transitPlanData &&
      lastPublication.current.identity === identity
    )
      return;
    const active = store.transitItineraries[store.activeItineraryIndex];
    const sameSearch = publishedOwner.current === pagingIdentity;
    publishedOwner.current = pagingIdentity;
    const items = mergeTransitItineraryPage({
      existing: transitPageToken ? store.transitItineraries : [],
      incoming: transitPlanData.itineraries,
      provider: transitPlanData.provider,
      page: transitPageToken ? transitPageDirection : "initial",
      preference: transitRoutePreference,
    });
    const retained = retainedAlternative.current;
    if (
      !pending &&
      sameSearch &&
      retained?.identity === pagingIdentity &&
      active &&
      sameTransitItinerary(active, retained.itinerary)
    ) {
      const match = findTransitItinerary(items, active);
      if (
        match < 0 &&
        items.some(
          (it) =>
            it.source === active.source &&
            it.instance === active.instance &&
            it.datasetEpoch === active.datasetEpoch,
        )
      )
        items.push(active);
      retainedAlternative.current = {
        identity: pagingIdentity,
        itinerary: items[match] ?? active,
      };
    }
    lastPublication.current = { data: transitPlanData, identity };
    store.setTransitItineraries(items, currentKey);
    if (pending) {
      const index = items.findIndex(
        (item) => transitItineraryKey(item, transitPlanData.provider) === pending.itineraryKey,
      );
      const itinerary = items[index];
      if (store.completeTransitSelection(pending) && itinerary) {
        store.setActiveItineraryIndex(index);
        setSelectionToOpen({
          index,
          itineraryKey: pending.itineraryKey,
          itinerary,
          queryIdentity: pagingIdentity,
        });
      }
    } else if (sameSearch && active) {
      const index = findTransitItinerary(items, active);
      if (index >= 0) store.setActiveItineraryIndex(index);
    }
  }, [
    transitPlanData,
    pending,
    rawKey,
    currentKey,
    waitingForSelection,
    transitRoutePreference,
    transitPageToken,
    transitPageDirection,
    pagingIdentity,
  ]);

  return {
    queryIdentity: pagingIdentity,
    selectAlternative,
    isChained: transitIsChained,
    planQuery: waitingForSelection
      ? { ...transitPlanQuery, data: undefined, isLoading: true, isFetching: true }
      : transitPlanQuery,
    selectionToOpen,
    chainQuery: transitChainQuery,
    itineraries,
    replanOptions: request.replanOptions,
    attributions,
    paging: {
      isPage: Boolean(transitPageToken),
      previousToken:
        reference || waitingForSelection ? undefined : transitPlanData?.previousPageToken,
      nextToken: reference || waitingForSelection ? undefined : transitPlanData?.nextPageToken,
      loadPrevious: () => loadPage("previous", transitPlanData?.previousPageToken),
      loadNext: () => loadPage("next", transitPlanData?.nextPageToken),
    },
  };
}
