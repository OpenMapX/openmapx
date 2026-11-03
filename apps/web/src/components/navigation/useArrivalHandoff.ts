"use client";

import {
  bboxAroundPoint,
  type CategoryPlace,
  fetchDirections,
  haversineDistance,
  type LngLat,
  type Route,
  type TravelMode,
  useCategorySearch,
  useDataSourceSearch,
  useDataSources,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useLocale } from "next-intl";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type SaveParkingResult, useSaveParking } from "@/components/panels/parking/useSaveParking";
import { useNavigationMutations } from "@/lib/mobile/useNavigationMutations";
import { useStartNavigation } from "@/lib/mobile/useStartNavigation";
import {
  ARRIVAL_WAYPOINT_MATCH_TOLERANCE_METERS,
  setPendingArrivalHandoff,
  usePendingArrivalHandoff,
} from "./arrivalHandoffState";
import {
  byDistance,
  MEASURED_PARKING,
  measureParkingLegs,
  type ParkingLegs,
  rankParking,
} from "./arrivalParkingLegs";
import {
  fromParkingSourceResult,
  fromPlaceSearch,
  type NearbyParkingPlace,
  PARKING_SOURCE_ID,
} from "./nearbyParking";
import { getParkingCoords } from "./parkingCoords";

const PARKING_MODES = new Set<TravelMode>(["driving", "motorcycle"]);
const SEARCH_RADIUS_METERS = 500;
const MIN_WALKING_HANDOFF_METERS = 20;
/** Only sites taking vehicles now: the parking source judges their hours. */
const OPEN_NOW: Record<string, unknown> = { open_now: true };
const PARKING_LEG_TIMEOUT_MS = 15_000;

/** A point to about ten metres, so position noise does not restart a measurement. */
function roundedPoint([lng, lat]: LngLat): string {
  return `${lng.toFixed(4)},${lat.toFixed(4)}`;
}

export interface UseArrivalHandoffOptions {
  onClose: () => void;
  destinationName?: string | null;
}

export interface UseArrivalHandoffResult {
  destinationName: string | null;
  destinationCoords: LngLat | null;
  canSaveParking: boolean;
  showParkingOptions: boolean;
  isSavingParking: boolean;
  isParkingSaved: boolean;
  handleSaveParking: () => Promise<SaveParkingResult>;
  walkingRoute: Route | null;
  isWalkingLoading: boolean;
  handleStartWalking: () => Promise<boolean>;
  nearbyParking: NearbyParkingPlace[];
  isParkingLoading: boolean;
  selectedParking: CategoryPlace | null;
  handleSelectParking: (place: CategoryPlace | null) => void;
  handleDriveToParking: (place: CategoryPlace) => Promise<boolean>;
  isStartingHandoff: boolean;
  handleDone: () => void;
}

interface PlannedGroundRoute {
  route: Route;
  alternatives: Route[];
  provider?: string;
}

function finalPoint(route: Route | null, waypoints: LngLat[]): LngLat | null {
  return waypoints.at(-1) ?? route?.geometry.at(-1) ?? null;
}

export function useArrivalHandoff({
  onClose,
  destinationName = null,
}: UseArrivalHandoffOptions): UseArrivalHandoffResult {
  const locale = useLocale();
  const units = useSettingsStore((state) => state.units);
  const kind = useNavigationStore((state) => state.kind);
  const mode = useNavigationStore((state) => state.mode);
  const route = useNavigationStore((state) => state.route);
  const waypoints = useNavigationStore((state) => state.destinationWaypoints);
  const progress = useNavigationStore((state) => state.progress);
  const routeOptions = useNavigationStore((state) => state.routeOptions);
  const routeProvider = useNavigationStore((state) => state.routeProvider);
  const pendingHandoff = usePendingArrivalHandoff();
  const { completeArrival } = useNavigationMutations();
  const { startGround } = useStartNavigation();
  const { saveHere, isSaving: isSavingParking } = useSaveParking();

  const [isParkingSaved, setIsParkingSaved] = useState(false);
  const [selectedParking, setSelectedParking] = useState<CategoryPlace | null>(null);
  const [walkingPlan, setWalkingPlan] = useState<PlannedGroundRoute | null>(null);
  const [isWalkingLoading, setIsWalkingLoading] = useState(false);
  const [isStartingHandoff, setIsStartingHandoff] = useState(false);
  const walkRequestId = useRef(0);
  const handoffInFlight = useRef(false);

  const isDrivingArrival = kind === "ground" && PARKING_MODES.has(mode);
  const routeEndpoint = route?.geometry.at(-1) ?? null;
  const activePendingHandoff =
    pendingHandoff &&
    routeEndpoint &&
    haversineDistance(pendingHandoff.parkingCoords, routeEndpoint) <=
      ARRIVAL_WAYPOINT_MATCH_TOLERANCE_METERS
      ? pendingHandoff
      : null;

  useEffect(() => {
    if (pendingHandoff && routeEndpoint && !activePendingHandoff) {
      setPendingArrivalHandoff(null);
    }
  }, [activePendingHandoff, pendingHandoff, routeEndpoint]);
  const canSaveParking = isDrivingArrival;
  const showParkingOptions = isDrivingArrival && activePendingHandoff === null;
  const destinationCoords = activePendingHandoff?.destinationCoords ?? finalPoint(route, waypoints);
  const resolvedDestinationName = activePendingHandoff?.destinationName ?? destinationName;
  const currentCoords = progress?.snapped ?? route?.geometry.at(-1) ?? destinationCoords;

  const parkingBbox = useMemo(
    () =>
      showParkingOptions && destinationCoords
        ? bboxAroundPoint(destinationCoords, SEARCH_RADIUS_METERS)
        : null,
    [destinationCoords, showParkingOptions],
  );
  // The parking source knows which sites are closed, kept for others or full;
  // the place search stands in while it is not offered or does not answer.
  const { data: dataSources, isLoading: isSourceListLoading } = useDataSources();
  const hasParkingSource =
    dataSources?.sources.some((source) => source.id === PARKING_SOURCE_ID) ?? false;
  const parkingSourceSearch = useDataSourceSearch(
    showParkingOptions && hasParkingSource ? PARKING_SOURCE_ID : null,
    parkingBbox,
    OPEN_NOW,
  );
  const parkingSourceFailed =
    parkingSourceSearch.isError ||
    (parkingSourceSearch.partial === "unavailable" && !parkingSourceSearch.data?.length);
  const fromParkingSource = hasParkingSource && !parkingSourceFailed;
  const { data: poiData, isLoading: isPoiLoading } = useCategorySearch(
    showParkingOptions && !isSourceListLoading && !fromParkingSource ? "parking" : null,
    parkingBbox,
    locale,
  );
  const isParkingLoading =
    showParkingOptions &&
    (isSourceListLoading || (fromParkingSource ? parkingSourceSearch.isLoading : isPoiLoading));

  const closestParking = useMemo(() => {
    if (!destinationCoords) return [];
    const candidates = fromParkingSource
      ? (parkingSourceSearch.data ?? []).map(fromParkingSourceResult)
      : (poiData?.results ?? []).map((place) => fromPlaceSearch(place));
    return byDistance(
      candidates.filter((place): place is NearbyParkingPlace => place !== null),
      destinationCoords,
    );
  }, [destinationCoords, fromParkingSource, parkingSourceSearch.data, poiData]);

  // The closest few are measured by the drive to them and the walk on to the
  // destination, once per arrival and shortlist rather than per position fix.
  const measuredParking = useMemo(
    () => closestParking.slice(0, MEASURED_PARKING),
    [closestParking],
  );
  const measureKey =
    showParkingOptions && currentCoords && destinationCoords && measuredParking.length > 0
      ? JSON.stringify([
          roundedPoint(currentCoords),
          roundedPoint(destinationCoords),
          mode,
          measuredParking.map((place) => place.id),
        ])
      : null;
  const measureInputs = useRef({
    currentCoords,
    destinationCoords,
    measuredParking,
    mode,
    routeOptions,
    units,
    locale,
  });
  measureInputs.current = {
    currentCoords,
    destinationCoords,
    measuredParking,
    mode,
    routeOptions,
    units,
    locale,
  };
  const [measuredLegs, setMeasuredLegs] = useState<{ key: string; legs: ParkingLegs[] } | null>(
    null,
  );
  useEffect(() => {
    const inputs = measureInputs.current;
    if (!measureKey || !inputs.currentCoords || !inputs.destinationCoords) return;
    const controller = new AbortController();
    const plan = (params: Parameters<typeof fetchDirections>[0], signal: AbortSignal) =>
      fetchDirections(params, undefined, { signal, timeoutMs: PARKING_LEG_TIMEOUT_MS });
    void measureParkingLegs({
      from: inputs.currentCoords,
      destination: inputs.destinationCoords,
      candidates: inputs.measuredParking,
      signal: controller.signal,
      drive: (legWaypoints, signal) =>
        plan(
          {
            waypoints: legWaypoints,
            mode: inputs.mode,
            units: inputs.units,
            lang: inputs.locale,
            ...inputs.routeOptions,
          },
          signal,
        ),
      walk: (legWaypoints, signal) =>
        plan(
          { waypoints: legWaypoints, mode: "walking", units: inputs.units, lang: inputs.locale },
          signal,
        ),
    })
      .then((legs) => {
        if (!controller.signal.aborted) setMeasuredLegs({ key: measureKey, legs });
      })
      .catch(() => {
        // Cancelled for a newer shortlist; the distance order stands meanwhile.
      });
    return () => controller.abort();
  }, [measureKey]);

  const nearbyParking = useMemo(
    () =>
      rankParking(
        closestParking,
        measuredLegs && measuredLegs.key === measureKey ? measuredLegs.legs : null,
      ),
    [closestParking, measuredLegs, measureKey],
  );

  useEffect(() => {
    if (selectedParking && !nearbyParking.some((place) => place.id === selectedParking.id)) {
      setSelectedParking(null);
    }
  }, [nearbyParking, selectedParking]);

  const walkOrigin = currentCoords;
  const walkDistance =
    walkOrigin && destinationCoords ? haversineDistance(walkOrigin, destinationCoords) : 0;
  const shouldOfferWalking =
    isDrivingArrival &&
    walkOrigin !== null &&
    destinationCoords !== null &&
    walkDistance >= MIN_WALKING_HANDOFF_METERS;
  const walkKey = shouldOfferWalking
    ? `${walkOrigin[0].toFixed(5)},${walkOrigin[1].toFixed(5)}:${destinationCoords[0].toFixed(5)},${destinationCoords[1].toFixed(5)}`
    : null;

  // Compute only a useful final walking leg. Ordinary arrival coordinates are
  // already at the destination, so requesting a zero-length route is noise.
  useEffect(() => {
    const origin = walkOrigin;
    const destination = destinationCoords;
    if (!walkKey || !origin || !destination) {
      walkRequestId.current += 1;
      setWalkingPlan(null);
      setIsWalkingLoading(false);
      return;
    }
    const requestId = ++walkRequestId.current;
    let active = true;
    setWalkingPlan(null);
    setIsWalkingLoading(true);
    void fetchDirections({ waypoints: [origin, destination], mode: "walking", units, lang: locale })
      .then((result) => {
        if (active && requestId === walkRequestId.current) {
          const [walkRoute, ...alternatives] = result.routes;
          setWalkingPlan(
            walkRoute
              ? {
                  route: walkRoute,
                  alternatives,
                  ...(result.provider ? { provider: result.provider } : {}),
                }
              : null,
          );
        }
      })
      .catch(() => {
        if (active && requestId === walkRequestId.current) setWalkingPlan(null);
      })
      .finally(() => {
        if (active && requestId === walkRequestId.current) setIsWalkingLoading(false);
      });
    return () => {
      active = false;
    };
  }, [destinationCoords, locale, units, walkKey, walkOrigin]);

  const handleSaveParking = useCallback(async (): Promise<SaveParkingResult> => {
    try {
      const result = await saveHere({ source: "arrival" });
      if (result === "saved") setIsParkingSaved(true);
      return result;
    } catch {
      return "failed";
    }
  }, [saveHere]);

  const handleSelectParking = useCallback((place: CategoryPlace | null) => {
    setSelectedParking((current) => (current?.id === place?.id ? current : place));
  }, []);

  const navigationLocale = locale.startsWith("de") ? "de" : "en";
  const handleDriveToParking = useCallback(
    async (place: CategoryPlace): Promise<boolean> => {
      const parkingCoords = getParkingCoords(place);
      if (!currentCoords || !parkingCoords || !destinationCoords || handoffInFlight.current) {
        return false;
      }
      handoffInFlight.current = true;
      setIsStartingHandoff(true);
      try {
        const result = await fetchDirections({
          waypoints: [currentCoords, parkingCoords],
          mode,
          units,
          lang: locale,
          ...routeOptions,
        });
        const [parkingRoute, ...alternatives] = result.routes;
        if (!parkingRoute) return false;
        const completed = await completeArrival();
        if (!completed) return false;
        setPendingArrivalHandoff({
          parkingCoords,
          destinationCoords,
          destinationName: resolvedDestinationName,
        });
        const started = await startGround({
          route: parkingRoute,
          alternatives,
          mode,
          destinationWaypoints: [currentCoords, parkingCoords],
          routeProvider: result.provider ?? routeProvider ?? undefined,
          routeSelectionIntent: "userSelected",
          routeOptions,
          locale: navigationLocale,
          units,
        });
        if (!started.ok) setPendingArrivalHandoff(null);
        return started.ok;
      } catch {
        setPendingArrivalHandoff(null);
        return false;
      } finally {
        handoffInFlight.current = false;
        setIsStartingHandoff(false);
      }
    },
    [
      completeArrival,
      currentCoords,
      destinationCoords,
      locale,
      mode,
      navigationLocale,
      resolvedDestinationName,
      routeOptions,
      routeProvider,
      startGround,
      units,
    ],
  );

  const handleStartWalking = useCallback(async (): Promise<boolean> => {
    if (!walkingPlan || !currentCoords || !destinationCoords || handoffInFlight.current) {
      return false;
    }
    handoffInFlight.current = true;
    setIsStartingHandoff(true);
    try {
      const completed = await completeArrival();
      if (!completed) return false;
      const started = await startGround({
        route: walkingPlan.route,
        alternatives: walkingPlan.alternatives,
        mode: "walking",
        destinationWaypoints: [currentCoords, destinationCoords],
        routeProvider: walkingPlan.provider ?? routeProvider ?? undefined,
        routeSelectionIntent: "userSelected",
        routeOptions,
        locale: navigationLocale,
        units,
      });
      setPendingArrivalHandoff(null);
      return started.ok;
    } catch {
      setPendingArrivalHandoff(null);
      return false;
    } finally {
      handoffInFlight.current = false;
      setIsStartingHandoff(false);
    }
  }, [
    completeArrival,
    currentCoords,
    destinationCoords,
    navigationLocale,
    routeOptions,
    routeProvider,
    startGround,
    units,
    walkingPlan,
  ]);

  const handleDone = useCallback(() => {
    setPendingArrivalHandoff(null);
    onClose();
  }, [onClose]);

  return {
    destinationName: resolvedDestinationName,
    destinationCoords,
    canSaveParking,
    showParkingOptions,
    isSavingParking,
    isParkingSaved,
    handleSaveParking,
    walkingRoute: walkingPlan?.route ?? null,
    isWalkingLoading,
    handleStartWalking,
    nearbyParking,
    isParkingLoading,
    selectedParking,
    handleSelectParking,
    handleDriveToParking,
    isStartingHandoff,
    handleDone,
  };
}
