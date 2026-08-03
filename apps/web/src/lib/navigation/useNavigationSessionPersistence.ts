"use client";

import {
  createNavigationSessionSnapshot,
  isNavigationSessionExpired,
  type NavigationSessionSnapshot,
  useNavigationStore,
} from "@openmapx/core";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { OFFLINE_PACKAGE_CHANGED_EVENT } from "../offlineAreas/packageDownload";
import type { OfflinePackageResolver } from "../offlineAreas/packageResolver";
import { getDefaultOfflinePackageResolver } from "../offlineAreas/packageResolver";
import {
  createNavigationSessionStorage,
  type NavigationSessionStorage,
} from "./navigationSessionStorage";
import { getOfflineRouteCoverage, type OfflineRouteCoverage } from "./offlineRouteCoverage";

const CHECKPOINT_TIME_MS = 15_000;
const CHECKPOINT_DISTANCE_M = 1_000;

export interface NavigationSessionResumeState {
  pending: NavigationSessionSnapshot | null;
  coverage: OfflineRouteCoverage;
  accept: () => void;
  discard: () => Promise<void>;
}

function isGroundActive(state: ReturnType<typeof useNavigationStore.getState>): boolean {
  return (
    state.kind === "ground" &&
    (state.status === "navigating" || state.status === "rerouting") &&
    !!state.route &&
    state.routes.length > 0 &&
    ["driving", "walking", "cycling", "motorcycle"].includes(state.mode)
  );
}

function routeListForState(state: ReturnType<typeof useNavigationStore.getState>) {
  const route = state.route;
  if (!route) return { routes: [], activeRouteIndex: 0 };
  const active = state.routes[state.activeRouteIndex];
  if (active === route) return { routes: state.routes, activeRouteIndex: state.activeRouteIndex };
  return {
    routes: [route, ...state.routes.filter((candidate) => candidate !== route)],
    activeRouteIndex: 0,
  };
}

function createSnapshotForState(
  state: ReturnType<typeof useNavigationStore.getState>,
  resolver: OfflinePackageResolver | undefined,
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
      packageIds: resolver?.packageIdsForGeometry(state.route.geometry) ?? [],
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

function sameProgress(
  a: ReturnType<typeof useNavigationStore.getState>["progress"],
  b: typeof a,
): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Persists one bounded ground-route checkpoint and exposes an explicit resume
 * prompt after reload. The hook never writes raw GPS history and never enters
 * navigation on its own.
 */
export function useNavigationSessionPersistence(
  storage?: NavigationSessionStorage,
  resolver?: OfflinePackageResolver,
): NavigationSessionResumeState {
  const storageRef = useMemo(() => storage ?? createNavigationSessionStorage(), [storage]);
  const resolveResolver = useCallback(
    () => resolver ?? getDefaultOfflinePackageResolver(),
    [resolver],
  );
  const [pending, setPending] = useState<NavigationSessionSnapshot | null>(null);
  const [coverage, setCoverage] = useState<OfflineRouteCoverage>({
    kind: "not-downloaded",
    packageIds: [],
  });
  const readRef = useRef(false);
  const lastWriteRef = useRef<{ atMs: number; alongMeters: number } | null>(null);
  const writeQueueRef = useRef(Promise.resolve());

  const enqueueWrite = useCallback(
    (state: ReturnType<typeof useNavigationStore.getState>) => {
      const nowMs = Date.now();
      const snapshot = createSnapshotForState(state, resolveResolver(), nowMs);
      if (!snapshot) return;
      writeQueueRef.current = writeQueueRef.current
        .catch(() => {})
        .then(async () => {
          await storageRef.write(snapshot);
          lastWriteRef.current = {
            atMs: nowMs,
            alongMeters: snapshot.progress?.alongMeters ?? 0,
          };
        });
    },
    [resolveResolver, storageRef],
  );

  useEffect(() => {
    if (readRef.current) return;
    readRef.current = true;
    let cancelled = false;
    void storageRef.read().then((snapshot) => {
      if (cancelled || !snapshot || useNavigationStore.getState().status !== "idle") return;
      if (isNavigationSessionExpired(snapshot, Date.now())) {
        void storageRef.clear();
        return;
      }
      setPending(snapshot);
      const resolverNow = resolveResolver();
      if (resolverNow) {
        setCoverage(
          getOfflineRouteCoverage(
            snapshot,
            resolverNow,
            snapshot.progress?.snapped ?? snapshot.route.geometry[0],
          ),
        );
      } else {
        setCoverage(
          snapshot.packageIds.length > 0
            ? { kind: "route-line-only", packageIds: snapshot.packageIds }
            : { kind: "not-downloaded", packageIds: [] },
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [resolveResolver, storageRef]);

  useEffect(() => {
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
          setPending(null);
        }
        previous = next;
        return;
      }

      const routeChanged =
        !wasActive ||
        next.route !== previous.route ||
        next.routes !== previous.routes ||
        next.activeRouteIndex !== previous.activeRouteIndex ||
        next.mode !== previous.mode ||
        next.routeProvider !== previous.routeProvider ||
        JSON.stringify(next.routeOptions) !== JSON.stringify(previous.routeOptions) ||
        JSON.stringify(next.destinationWaypoints) !== JSON.stringify(previous.destinationWaypoints);
      const progressChanged = !sameProgress(next.progress, previous.progress);
      const nowMs = Date.now();
      const last = lastWriteRef.current;
      const checkpointReached =
        !!last &&
        nowMs - last.atMs >= CHECKPOINT_TIME_MS &&
        (next.progress?.alongMeters ?? 0) - last.alongMeters >= CHECKPOINT_DISTANCE_M;

      if (routeChanged || (progressChanged && (!last || checkpointReached))) enqueueWrite(next);
      const resolverNow = resolveResolver();
      const currentSnapshot = createSnapshotForState(next, resolverNow, nowMs);
      if (currentSnapshot && resolverNow) {
        setCoverage(
          getOfflineRouteCoverage(
            currentSnapshot,
            resolverNow,
            currentSnapshot.progress?.snapped ?? currentSnapshot.route.geometry[0],
          ),
        );
      }
      previous = next;
    });
  }, [enqueueWrite, resolveResolver, storageRef]);

  useEffect(() => {
    const state = useNavigationStore.getState();
    if (!isGroundActive(state)) return;
    const current = createSnapshotForState(state, resolveResolver(), Date.now());
    if (!current) return;
    const resolverNow = resolveResolver();
    if (resolverNow) {
      setCoverage(
        getOfflineRouteCoverage(
          current,
          resolverNow,
          current.progress?.snapped ?? current.route.geometry[0],
        ),
      );
    } else {
      setCoverage(
        current.packageIds.length > 0
          ? { kind: "route-line-only", packageIds: current.packageIds }
          : { kind: "not-downloaded", packageIds: [] },
      );
    }
  }, [resolveResolver]);

  useEffect(() => {
    const onPackageChanged = () => {
      const resolverNow = resolveResolver();
      if (!resolverNow) return;
      void resolverNow.refresh().then(() => {
        const current =
          pending ?? createSnapshotForState(useNavigationStore.getState(), resolverNow, Date.now());
        if (!current) return;
        setCoverage(
          getOfflineRouteCoverage(
            current,
            resolverNow,
            current.progress?.snapped ?? current.route.geometry[0],
          ),
        );
      });
    };
    window.addEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, onPackageChanged);
    return () => window.removeEventListener(OFFLINE_PACKAGE_CHANGED_EVENT, onPackageChanged);
  }, [pending, resolveResolver]);

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
