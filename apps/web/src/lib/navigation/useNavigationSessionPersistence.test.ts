// @vitest-environment jsdom

import type { NavigationSessionSnapshot, NavProgress, Route } from "@openmapx/core";
import { createNavigationSessionSnapshot, useNavigationStore } from "@openmapx/core";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_GLOBAL } from "../mobile/mobileShellEnvironment";
import { OFFLINE_PACKAGE_CHANGED_EVENT } from "../offlineAreas/packageDownload";
import type { OfflinePackageResolver } from "../offlineAreas/packageResolver";
import type { OfflinePackageRecord } from "../offlineAreas/types";
import type { NavigationSessionStorage } from "./navigationSessionStorage";
import type { OfflineRouteCoverage } from "./offlineRouteCoverage";
import { useNavigationSessionPersistence } from "./useNavigationSessionPersistence";

// Mock factories are hoisted above every module-level binding in this file, so
// the counters they share with the tests live on `globalThis`.
interface TestGlobals {
  snapshotBuilds: number;
  discoveredResolver: unknown;
}

vi.mock("../offlineAreas/runtime", () => ({
  ensureOfflinePackageRuntime: vi.fn(
    async () =>
      (globalThis as unknown as { openmapxTest: TestGlobals }).openmapxTest.discoveredResolver,
  ),
  resetOfflinePackageRuntime: vi.fn(),
  currentOfflinePackageResolver: vi.fn(() => undefined),
}));

// Counting snapshot construction is the point of these tests, so the shared
// core barrel is re-exported with a counter around that one factory. Everything
// else — including the navigation store singleton — stays the real module.
vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  const container = globalThis as unknown as { openmapxTest: TestGlobals };
  return {
    ...actual,
    createNavigationSessionSnapshot: (
      input: Parameters<typeof actual.createNavigationSessionSnapshot>[0],
    ) => {
      container.openmapxTest.snapshotBuilds += 1;
      return actual.createNavigationSessionSnapshot(input);
    },
  };
});

const shared: TestGlobals = { snapshotBuilds: 0, discoveredResolver: undefined };
(globalThis as unknown as { openmapxTest: TestGlobals }).openmapxTest = shared;

const geometry: [number, number][] = [
  [0, 0],
  [0.01, 0],
  [0.02, 0],
];
const route: Route = {
  distance: 2000,
  duration: 100,
  geometry,
  legs: [
    {
      distance: 2000,
      duration: 100,
      geometry,
      steps: [{ instruction: "Continue", distance: 2000, duration: 100, coordinates: geometry }],
    },
  ],
  steps: [{ instruction: "Continue", distance: 2000, duration: 100, coordinates: geometry }],
  mode: "driving",
};

const waypoints: [number, number][] = [
  [0, 0],
  [0.02, 0],
];

const packageId = `omp2-${"a".repeat(64)}`;

function makeSnapshot() {
  return createNavigationSessionSnapshot({
    route,
    routes: [route],
    activeRouteIndex: 0,
    routeSelectionIntent: "automatic",
    mode: "driving",
    routeOptions: {
      avoidHighways: false,
      avoidTolls: false,
      avoidFerries: false,
      avoidClosures: false,
    },
    routeProvider: null,
    destinationWaypoints: [
      [0, 0],
      [0.02, 0],
    ],
    progress: null,
    packageIds: [],
    startedAtMs: Date.now(),
    updatedAtMs: Date.now(),
  });
}

function progressAt(alongMeters: number, etaEpochMs: number): NavProgress {
  return {
    currentStepIndex: 0,
    distanceToNextManeuver: Math.max(0, 2000 - alongMeters),
    distanceRemaining: Math.max(0, 2000 - alongMeters),
    durationRemaining: 95,
    snapped: [alongMeters / 100_000, 0],
    alongMeters,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs,
    bearing: 90,
    speedMps: 10,
  };
}

function memoryStorage(
  initial?: NavigationSessionSnapshot,
): NavigationSessionStorage & { writes: unknown[]; cleared: number } {
  let value: unknown = initial;
  const result = {
    writes: [] as unknown[],
    cleared: 0,
    async read() {
      return value as NavigationSessionSnapshot | null;
    },
    async write(snapshot: NavigationSessionSnapshot) {
      value = snapshot;
      result.writes.push(snapshot);
    },
    async clear() {
      value = undefined;
      result.cleared += 1;
    },
  };
  return result;
}

/** Memory storage whose in-flight writes can be held, resolved, or rejected. */
function controllableStorage(initial?: NavigationSessionSnapshot) {
  let value: unknown = initial;
  let holding = false;
  const inFlight: { resolve: () => void; reject: (reason: unknown) => void }[] = [];
  const result = {
    writes: [] as NavigationSessionSnapshot[],
    cleared: 0,
    hold() {
      holding = true;
    },
    settleAll() {
      holding = false;
      for (const entry of inFlight.splice(0)) entry.resolve();
    },
    rejectAll() {
      holding = false;
      for (const entry of inFlight.splice(0)) entry.reject(new Error("write failed"));
    },
    async read() {
      return value as NavigationSessionSnapshot | null;
    },
    write(snapshot: NavigationSessionSnapshot) {
      result.writes.push(snapshot);
      value = snapshot;
      if (!holding) return Promise.resolve();
      return new Promise<void>((resolve, reject) => inFlight.push({ resolve, reject }));
    },
    async clear() {
      value = undefined;
      result.cleared += 1;
    },
  };
  return result;
}

function fakeResolver(options: { covered?: boolean; packageIds?: string[] } = {}) {
  const record = { id: packageId } as OfflinePackageRecord;
  const resolver = {
    refresh: vi.fn(async () => {}),
    packageForCoordinate: vi.fn(() => (options.covered === false ? undefined : record)),
    packageIdsForGeometry: vi.fn(() => [...(options.packageIds ?? [packageId])]),
    compatiblePackageIds: vi.fn(() => [packageId]),
    get: vi.fn(() => record),
    openReader: vi.fn(async () => {
      throw new Error("not used");
    }),
    close: vi.fn(async () => {}),
  };
  return resolver as unknown as OfflinePackageResolver & typeof resolver;
}

function start() {
  useNavigationStore.getState().startGroundNavigation(route, "driving", waypoints);
}

describe("useNavigationSessionPersistence", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    shared.snapshotBuilds = 0;
    shared.discoveredResolver = undefined;
  });

  it("offers a saved route without entering navigation and accepts explicitly", async () => {
    const storage = memoryStorage(makeSnapshot());
    const { result } = renderHook(() => useNavigationSessionPersistence(storage));
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(useNavigationStore.getState().status).toBe("idle");
    act(() => result.current.accept());
    expect(useNavigationStore.getState().status).toBe("navigating");
    expect(result.current.pending).toBeNull();
  });

  it("writes a new active route and clears it on stop", async () => {
    const storage = memoryStorage();
    renderHook(() => useNavigationSessionPersistence(storage));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));
    act(() => useNavigationStore.getState().stopNavigation());
    await waitFor(() => expect(storage.cleared).toBe(1));
  });

  it("does not persist every progress update inside the checkpoint window", async () => {
    const storage = memoryStorage();
    renderHook(() => useNavigationSessionPersistence(storage));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));
    act(() => useNavigationStore.getState().applyProgress(progressAt(100, Date.now() + 95_000)));
    expect(storage.writes.length).toBe(1);
  });

  it("persists progress after either the distance or time checkpoint", async () => {
    let nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = memoryStorage();
    renderHook(() => useNavigationSessionPersistence(storage, undefined, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));

    nowMs += 1_000;
    act(() => useNavigationStore.getState().applyProgress(progressAt(1_000, nowMs + 50_000)));
    await waitFor(() => expect(storage.writes.length).toBe(2));

    nowMs += 15_000;
    act(() => useNavigationStore.getState().applyProgress(progressAt(1_100, nowMs + 45_000)));
    await waitFor(() => expect(storage.writes.length).toBe(3));
  });

  it("discards the pending route without starting navigation", async () => {
    const storage = memoryStorage(makeSnapshot());
    const { result } = renderHook(() => useNavigationSessionPersistence(storage));
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    await act(async () => result.current.discard());
    expect(result.current.pending).toBeNull();
    expect(storage.cleared).toBe(1);
    expect(useNavigationStore.getState().status).toBe("idle");
  });

  it("builds no snapshot, writes nothing, and rescans no route between checkpoints", async () => {
    let nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver();
    const publications: OfflineRouteCoverage[] = [];
    const { result } = renderHook(() => {
      const state = useNavigationSessionPersistence(storage, resolver, now);
      if (publications[publications.length - 1] !== state.coverage)
        publications.push(state.coverage);
      return state;
    });
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));

    const snapshotsBefore = shared.snapshotBuilds;
    const scansBefore = resolver.packageIdsForGeometry.mock.calls.length;
    const publicationsBefore = publications.length;
    const coverageBefore = result.current.coverage;

    act(() => {
      for (let index = 1; index <= 100; index += 1) {
        nowMs += 100;
        useNavigationStore.getState().applyProgress(progressAt(index * 5, nowMs + 90_000));
      }
    });

    expect(storage.writes.length).toBe(1);
    expect(shared.snapshotBuilds).toBe(snapshotsBefore);
    expect(resolver.packageIdsForGeometry.mock.calls.length).toBe(scansBefore);
    expect(publications.length).toBe(publicationsBefore);
    expect(result.current.coverage).toBe(coverageBefore);
    // Checking the live point is allowed; only the full-route scan is not.
    expect(resolver.packageForCoordinate.mock.calls.length).toBeGreaterThanOrEqual(100);
  });

  it("does not enqueue a burst of writes while the first write is still pending", async () => {
    let nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver();
    storage.hold();
    renderHook(() => useNavigationSessionPersistence(storage, resolver, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));

    act(() => {
      for (let index = 1; index <= 100; index += 1) {
        nowMs += 100;
        useNavigationStore.getState().applyProgress(progressAt(index * 5, nowMs + 90_000));
      }
    });

    expect(storage.writes.length).toBe(1);
    expect(shared.snapshotBuilds).toBe(1);

    await act(async () => {
      storage.settleAll();
    });
    expect(storage.writes.length).toBe(1);
  });

  it("retries at the next progress update when a write fails", async () => {
    let nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver();
    storage.hold();
    renderHook(() => useNavigationSessionPersistence(storage, resolver, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));

    await act(async () => {
      storage.rejectAll();
    });

    // The failed checkpoint was not consumed, so the very next fix rewrites it
    // instead of waiting out another full window.
    nowMs += 100;
    act(() => useNavigationStore.getState().applyProgress(progressAt(5, nowMs + 90_000)));
    await waitFor(() => expect(storage.writes.length).toBe(2));

    act(() => {
      for (let index = 2; index <= 100; index += 1) {
        nowMs += 100;
        useNavigationStore.getState().applyProgress(progressAt(index * 5, nowMs + 90_000));
      }
    });
    expect(storage.writes.length).toBe(2);
  });

  it("publishes coverage again only when its semantic value changes", async () => {
    let nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver({ covered: false, packageIds: [packageId] });
    const { result } = renderHook(() => useNavigationSessionPersistence(storage, resolver, now));
    act(start);
    await waitFor(() => expect(result.current.coverage.kind).toBe("route-line-only"));
    const first = result.current.coverage;

    act(() => {
      for (let index = 1; index <= 10; index += 1) {
        nowMs += 100;
        useNavigationStore.getState().applyProgress(progressAt(index * 5, nowMs + 90_000));
      }
    });
    expect(result.current.coverage).toBe(first);

    resolver.packageForCoordinate.mockReturnValue({ id: packageId } as OfflinePackageRecord);
    nowMs += 100;
    act(() => useNavigationStore.getState().applyProgress(progressAt(60, nowMs + 90_000)));
    expect(result.current.coverage).toEqual({ kind: "covered", packageId });
  });

  it("invalidates route membership exactly once per package change", async () => {
    const nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver({ covered: false });
    renderHook(() => useNavigationSessionPersistence(storage, resolver, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));
    const scansBefore = resolver.packageIdsForGeometry.mock.calls.length;

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OFFLINE_PACKAGE_CHANGED_EVENT));
    });
    expect(resolver.refresh).toHaveBeenCalledTimes(1);
    expect(resolver.packageIdsForGeometry.mock.calls.length).toBe(scansBefore + 1);

    await act(async () => {
      window.dispatchEvent(new CustomEvent(OFFLINE_PACKAGE_CHANGED_EVENT));
    });
    expect(resolver.packageIdsForGeometry.mock.calls.length).toBe(scansBefore + 2);
  });

  it("adopts the first ready package for a pending session without a store change", async () => {
    const storage = memoryStorage(makeSnapshot());
    const { result } = renderHook(() => useNavigationSessionPersistence(storage));
    await waitFor(() => expect(result.current.pending).not.toBeNull());
    expect(result.current.coverage).toEqual({ kind: "not-downloaded", packageIds: [] });

    const resolver = fakeResolver();
    shared.discoveredResolver = resolver;
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OFFLINE_PACKAGE_CHANGED_EVENT));
    });

    await waitFor(() => expect(result.current.coverage).toEqual({ kind: "covered", packageId }));
    expect(useNavigationStore.getState().status).toBe("idle");
  });

  it("writes the first package ids once a resolver appears mid-route", async () => {
    const nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    renderHook(() => useNavigationSessionPersistence(storage, undefined, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));
    expect(storage.writes[0].packageIds).toEqual([]);

    const resolver = fakeResolver();
    shared.discoveredResolver = resolver;
    await act(async () => {
      window.dispatchEvent(new CustomEvent(OFFLINE_PACKAGE_CHANGED_EVENT));
    });
    await waitFor(() => expect(storage.writes.length).toBe(2));
    expect(storage.writes[1].packageIds).toEqual([packageId]);
  });

  it("does not schedule a checkpoint for unrelated store actions", async () => {
    let nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver();
    renderHook(() => useNavigationSessionPersistence(storage, resolver, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));

    nowMs += 60_000;
    act(() => {
      useNavigationStore.getState().setWeakGps(true);
      useNavigationStore.getState().setOffRoute(true);
      useNavigationStore.getState().setSpeedLimit(50);
      useNavigationStore.getState().setCameraMode("free");
    });
    expect(storage.writes.length).toBe(1);
    expect(shared.snapshotBuilds).toBe(1);
  });

  it("schedules a checkpoint when the store replaces waypoints or options", async () => {
    const nowMs = Date.now() + 1_000;
    const now = () => nowMs;
    const storage = controllableStorage();
    const resolver = fakeResolver();
    renderHook(() => useNavigationSessionPersistence(storage, resolver, now));
    act(start);
    await waitFor(() => expect(storage.writes.length).toBe(1));

    act(() =>
      useNavigationStore.getState().addStop(route, [
        [0, 0],
        [0.01, 0],
        [0.02, 0],
      ]),
    );
    await waitFor(() => expect(storage.writes.length).toBe(2));
  });
});

describe("navigation store persistence identity", () => {
  beforeEach(() => useNavigationStore.getState().stopNavigation());

  it("keeps persistence identity references stable across unrelated actions", () => {
    act(start);
    const before = useNavigationStore.getState();
    act(() => {
      useNavigationStore.getState().setWeakGps(true);
      useNavigationStore.getState().setOffRoute(true);
      useNavigationStore.getState().setConnectivity("offline");
      useNavigationStore.getState().applyProgress(progressAt(10, Date.now()));
    });
    const after = useNavigationStore.getState();
    expect(after.routeOptions).toBe(before.routeOptions);
    expect(after.destinationWaypoints).toBe(before.destinationWaypoints);
    expect(after.route).toBe(before.route);
    expect(after.routes).toBe(before.routes);
  });

  it("replaces the progress and waypoint references when they legitimately change", () => {
    act(start);
    const before = useNavigationStore.getState();
    act(() => useNavigationStore.getState().applyProgress(progressAt(10, Date.now())));
    expect(useNavigationStore.getState().progress).not.toBe(before.progress);

    act(() =>
      useNavigationStore.getState().addStop(route, [
        [0, 0],
        [0.01, 0],
        [0.02, 0],
      ]),
    );
    expect(useNavigationStore.getState().destinationWaypoints).not.toBe(
      before.destinationWaypoints,
    );
  });
});

describe("useNavigationSessionPersistence inside the installed shell", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL] = { nonce: "abc123" };
  });

  afterEach(() => {
    delete (globalThis as Record<string, unknown>)[CHANNEL_GLOBAL];
  });

  it("offers nothing from a browser-persisted session", async () => {
    const storage = memoryStorage(makeSnapshot());

    const { result } = renderHook(() => useNavigationSessionPersistence(storage));

    // Native owns the durable session; restoring a second one here would resume
    // a trip the shell has no idea about.
    await waitFor(() => expect(result.current.pending).toBeNull());
    expect(result.current.pending).toBeNull();
  });

  it("writes nothing when a session becomes active", async () => {
    const storage = memoryStorage();
    renderHook(() => useNavigationSessionPersistence(storage));

    act(start);

    await waitFor(() => expect(storage.writes).toEqual([]));
    expect(storage.writes).toEqual([]);
    expect(storage.cleared).toBe(0);
  });
});
