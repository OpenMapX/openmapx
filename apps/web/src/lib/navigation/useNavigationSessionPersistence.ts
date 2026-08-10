"use client";

import {
  createNavigationSessionSnapshot,
  isNavigationSessionExpired,
  type LngLat,
  type NavigationSessionSnapshot,
  type Route,
  useNavigationStore,
} from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { shellFeatureBoundary } from "../mobile/mobileShellEnvironment";
import { OFFLINE_PACKAGE_CHANGED_EVENT } from "../offlineAreas/packageDownload";
import type { OfflinePackageResolver } from "../offlineAreas/packageResolver";
import { getDefaultOfflinePackageResolver } from "../offlineAreas/packageResolver";
import { ensureOfflinePackageRuntime } from "../offlineAreas/runtime";
import {
  createNavigationSessionStorage,
  type NavigationSessionStorage,
} from "./navigationSessionStorage";
import {
  getOfflineRouteCoverage,
  type OfflineRouteCoverage,
  sameOfflineRouteCoverage,
} from "./offlineRouteCoverage";

const CHECKPOINT_TIME_MS = 15_000;
const CHECKPOINT_DISTANCE_M = 1_000;

const NO_PACKAGE_IDS: readonly string[] = [];
const NO_COVERAGE: OfflineRouteCoverage = { kind: "not-downloaded", packageIds: [] };

type NavigationState = ReturnType<typeof useNavigationStore.getState>;

/** When the last snapshot was scheduled/persisted, in both checkpoint units. */
interface Checkpoint {
  atMs: number;
  alongMeters: number;
}

/** Route-to-package membership, valid while its three cache keys all hold. */
interface RoutePackageCache {
  resolver: OfflinePackageResolver;
  geometry: LngLat[];
  generation: number;
  ids: string[];
}

export interface NavigationSessionResumeState {
  pending: NavigationSessionSnapshot | null;
  coverage: OfflineRouteCoverage;
  accept: () => void;
  discard: () => Promise<void>;
}

function isGroundActive(state: NavigationState): boolean {
  return (
    state.kind === "ground" &&
    (state.status === "navigating" || state.status === "rerouting") &&
    !!state.route &&
    state.routes.length > 0 &&
    ["driving", "walking", "cycling", "motorcycle"].includes(state.mode)
  );
}

function routeListForState(state: NavigationState) {
  const route = state.route;
  if (!route) return { routes: [], activeRouteIndex: 0 };
  const active = state.routes[state.activeRouteIndex];
  if (active === route) return { routes: state.routes, activeRouteIndex: state.activeRouteIndex };
  return {
    routes: [route, ...state.routes.filter((candidate) => candidate !== route)],
    activeRouteIndex: 0,
  };
}

function coordinateForRoute(route: Route, progress: NavigationState["progress"]): LngLat {
  return progress?.snapped ?? route.geometry[0];
}

function createSnapshotForState(
  state: NavigationState,
  packageIds: readonly string[],
  nowMs: number,
): NavigationSessionSnapshot | null {
  if (!isGroundActive(state) || !state.route) return null;
  const routeList = routeListForState(state);
  try {
    return createNavigationSessionSnapshot({
      route: state.route,
      routes: routeList.routes,
      activeRouteIndex: routeList.activeRouteIndex,
      routeSelectionIntent: state.routeSelectionIntent,
      mode: state.mode as "driving" | "walking" | "cycling" | "motorcycle",
      routeOptions: state.routeOptions,
      routeProvider: state.routeProvider,
      destinationWaypoints: state.destinationWaypoints,
      progress: state.progress,
      packageIds: [...packageIds],
      startedAtMs: state.navigationStartedAtMs ?? nowMs,
      updatedAtMs: nowMs,
    });
  } catch {
    // A malformed route must not break the active online navigation UI. It is
    // simply not eligible for local continuation until the router supplies all
    // maneuver fields required by the session schema.
    return null;
  }
}

/**
 * Persists one bounded ground-route checkpoint and exposes an explicit resume
 * prompt after reload. The hook never writes raw GPS history and never enters
 * navigation on its own.
 *
 * Snapshot construction is deliberately tied to the checkpoint cadence: copying,
 * fingerprinting and validating a full route is only worth doing when a write
 * follows. Everything between checkpoints reads the current fix and the cached
 * route-package membership.
 */
export function useNavigationSessionPersistence(
  storage?: NavigationSessionStorage,
  resolver?: OfflinePackageResolver,
  now: () => number = Date.now,
): NavigationSessionResumeState {
  const storageRef = useMemo(() => storage ?? createNavigationSessionStorage(), [storage]);
  // Inside the installed shell the durable session lives natively, in SQLite
  // that survives a process kill. A second durable owner would disagree with it
  // the first time one of the two crashed, and the browser copy is the one with
  // no way to keep guiding anybody.
  const persistenceAllowed = shellFeatureBoundary().browserSessionPersistence;
  const [discoveredResolver, setDiscoveredResolver] = useState<OfflinePackageResolver>();
  const resolveResolver = useCallback(
    () => resolver ?? discoveredResolver ?? getDefaultOfflinePackageResolver(),
    [discoveredResolver, resolver],
  );
  const [pending, setPending] = useState<NavigationSessionSnapshot | null>(null);
  const [coverage, setCoverage] = useState<OfflineRouteCoverage>(NO_COVERAGE);
  const readRef = useRef(false);
  // Two checkpoint marks. `scheduled` advances synchronously when a snapshot is
  // handed to the write queue, so fixes arriving while a write is still in
  // flight cannot open a second checkpoint in the same window. `written` only
  // advances once storage confirmed, and a rejected write rolls `scheduled`
  // back to it so the next eligible fix retries instead of losing the window.
  const lastWriteRef = useRef<Checkpoint | null>(null);
  const lastScheduledRef = useRef<Checkpoint | null>(null);
  const writeQueueRef = useRef(Promise.resolve());
  // The installed package set is the only thing that can invalidate cached
  // route membership, so every path that can change it bumps this counter.
  const generationRef = useRef(0);
  const routePackagesRef = useRef<RoutePackageCache | null>(null);
  const adoptedResolverRef = useRef<OfflinePackageResolver>(undefined);

  const routePackageIdsFor = useCallback(
    (route: Route, activeResolver: OfflinePackageResolver): readonly string[] => {
      const cached = routePackagesRef.current;
      if (
        cached &&
        cached.resolver === activeResolver &&
        cached.geometry === route.geometry &&
        cached.generation === generationRef.current
      ) {
        return cached.ids;
      }
      const ids = activeResolver.packageIdsForGeometry(route.geometry);
      routePackagesRef.current = {
        resolver: activeResolver,
        geometry: route.geometry,
        generation: generationRef.current,
        ids,
      };
      return ids;
    },
    [],
  );

  const publishCoverage = useCallback((next: OfflineRouteCoverage) => {
    setCoverage((previous) => (sameOfflineRouteCoverage(previous, next) ? previous : next));
  }, []);

  const coverageForRoute = useCallback(
    (route: Route, progress: NavigationState["progress"], activeResolver: OfflinePackageResolver) =>
      getOfflineRouteCoverage({
        coordinate: coordinateForRoute(route, progress),
        routePackageIds: routePackageIdsFor(route, activeResolver),
        resolver: activeResolver,
      }),
    [routePackageIdsFor],
  );

  /** Recompute whichever session is currently visible: pending, else active. */
  const refreshCoverage = useCallback(
    (activeResolver: OfflinePackageResolver) => {
      if (pending) {
        publishCoverage(coverageForRoute(pending.route, pending.progress, activeResolver));
        return;
      }
      const state = useNavigationStore.getState();
      if (!isGroundActive(state) || !state.route) return;
      publishCoverage(coverageForRoute(state.route, state.progress, activeResolver));
    },
    [coverageForRoute, pending, publishCoverage],
  );

  const enqueueWrite = useCallback(
    (snapshot: NavigationSessionSnapshot, atMs: number) => {
      const mark: Checkpoint = { atMs, alongMeters: snapshot.progress?.alongMeters ?? 0 };
      lastScheduledRef.current = mark;
      writeQueueRef.current = writeQueueRef.current
        .catch(() => {})
        .then(async () => {
          try {
            await storageRef.write(snapshot);
            lastWriteRef.current = mark;
          } catch {
            if (lastScheduledRef.current === mark) lastScheduledRef.current = lastWriteRef.current;
          }
        });
    },
    [storageRef],
  );

  const scheduleWrite = useCallback(
    (state: NavigationState, atMs: number, activeResolver: OfflinePackageResolver | undefined) => {
      const packageIds =
        activeResolver && state.route
          ? routePackageIdsFor(state.route, activeResolver)
          : NO_PACKAGE_IDS;
      const snapshot = createSnapshotForState(state, packageIds, atMs);
      if (!snapshot) return;
      enqueueWrite(snapshot, atMs);
    },
    [enqueueWrite, routePackageIdsFor],
  );

  /** Adopt a resolver that only became available after the hook mounted. */
  const adoptResolver = useCallback(
    (next: OfflinePackageResolver) => {
      const isNew = adoptedResolverRef.current !== next;
      adoptedResolverRef.current = next;
      setDiscoveredResolver(next);
      const state = useNavigationStore.getState();
      // The active session was persisted without package IDs; the resolver now
      // supplies them, which is worth exactly one replacement snapshot. Rerunning
      // discovery for the same resolver must not schedule another.
      if (isNew && isGroundActive(state)) scheduleWrite(state, now(), next);
      refreshCoverage(next);
    },
    [now, refreshCoverage, scheduleWrite],
  );

  useEffect(() => {
    if (resolver) return;
    let cancelled = false;
    void ensureOfflinePackageRuntime().then((localResolver) => {
      if (cancelled || !localResolver) return;
      adoptResolver(localResolver);
    });
    return () => {
      cancelled = true;
    };
  }, [adoptResolver, resolver]);

  useEffect(() => {
    if (!persistenceAllowed) return;
    if (readRef.current) return;
    readRef.current = true;
    let cancelled = false;
    void storageRef.read().then((snapshot) => {
      if (cancelled || !snapshot || useNavigationStore.getState().status !== "idle") return;
      if (isNavigationSessionExpired(snapshot, now())) {
        void storageRef.clear();
        return;
      }
      setPending(snapshot);
      // With a resolver present the coverage effect below recomputes against
      // live device state; without one the persisted IDs are all we know.
      if (!resolveResolver()) {
        publishCoverage(
          snapshot.packageIds.length > 0
            ? { kind: "route-line-only", packageIds: snapshot.packageIds }
            : NO_COVERAGE,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [now, persistenceAllowed, publishCoverage, resolveResolver, storageRef]);

  useEffect(() => {
    if (!persistenceAllowed) return;
    let previous = useNavigationStore.getState();
    return useNavigationStore.subscribe((next) => {
      const wasActive = isGroundActive(previous);
      const isActive = isGroundActive(next);

      if (!isActive) {
        if (
          wasActive &&
          (next.status === "idle" || next.status === "arrived" || next.kind !== "ground")
        ) {
          writeQueueRef.current = writeQueueRef.current
            .catch(() => {})
            .then(() => storageRef.clear());
          lastWriteRef.current = null;
          lastScheduledRef.current = null;
          setPending(null);
        }
        previous = next;
        return;
      }

      // The navigation store replaces route, options, waypoints and progress as
      // whole immutable objects and never edits them in place, so reference
      // identity is an exact change test here — no serialization needed.
      const routeChanged =
        !wasActive ||
        next.route !== previous.route ||
        next.routes !== previous.routes ||
        next.activeRouteIndex !== previous.activeRouteIndex ||
        next.mode !== previous.mode ||
        next.routeProvider !== previous.routeProvider ||
        next.routeOptions !== previous.routeOptions ||
        next.destinationWaypoints !== previous.destinationWaypoints;
      const progressChanged = next.progress !== previous.progress;
      previous = next;
      if (!routeChanged && !progressChanged) return;

      const nowMs = now();
      const scheduled = lastScheduledRef.current;
      const checkpointReached =
        !!scheduled &&
        (nowMs - scheduled.atMs >= CHECKPOINT_TIME_MS ||
          (next.progress?.alongMeters ?? 0) - scheduled.alongMeters >= CHECKPOINT_DISTANCE_M);
      const activeResolver = resolveResolver();

      if (routeChanged || !scheduled || checkpointReached) {
        scheduleWrite(next, nowMs, activeResolver);
      }
      if (activeResolver && next.route) {
        publishCoverage(coverageForRoute(next.route, next.progress, activeResolver));
      }
    });
  }, [
    coverageForRoute,
    now,
    persistenceAllowed,
    publishCoverage,
    resolveResolver,
    scheduleWrite,
    storageRef,
  ]);

  useEffect(() => {
    const activeResolver = resolveResolver();
    if (activeResolver) refreshCoverage(activeResolver);
  }, [refreshCoverage, resolveResolver]);

  useEffect(() => {
    const onPackageChanged = () => {
      // One bump per event: it invalidates route membership exactly once and
      // also fences any resolution still in flight from an earlier event.
      generationRef.current += 1;
      const generation = generationRef.current;
      const existing = resolveResolver();
      if (existing) {
        void existing.refresh().then(() => {
          if (generationRef.current !== generation) return;
          refreshCoverage(existing);
        });
        return;
      }
      // No resolver yet: the first package to become ready must refresh the
      // visible session on its own, without a navigation-store mutation or a
      // reload. Runtime discovery was already reset by the notifying side.
      void ensureOfflinePackageRuntime().then((discovered) => {
        if (!discovered || generationRef.current !== generation) return;
        adoptResolver(discovered);
      });
    };
    window.addEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, onPackageChanged);
    return () => window.removeEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, onPackageChanged);
  }, [adoptResolver, refreshCoverage, resolveResolver]);

  const accept = useCallback(() => {
    const snapshot = pending;
    if (!snapshot || useNavigationStore.getState().status !== "idle") return;
    useNavigationStore.getState().restoreGroundNavigation(snapshot);
    setPending(null);
  }, [pending]);

  const discard = useCallback(async () => {
    await storageRef.clear();
    setPending(null);
  }, [storageRef]);

  return { pending, coverage, accept, discard };
}
