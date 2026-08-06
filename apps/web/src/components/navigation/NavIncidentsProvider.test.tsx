// @vitest-environment jsdom

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Route } from "@integrations/routing/types";
import {
  type ActiveAlert,
  type FixInput,
  type RoadConditionEvent,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import { useNavIncidentResource } from "@openmapx/integration-framework/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render } from "@testing-library/react";
import { Suspense } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// The lazy loader (a template-literal `import()`, unanalyzable by tsc) — same
// as the production mount inside `<MapControls />` — so this test doesn't
// statically import an integration `.tsx` file into apps/web's own tsc
// program; that program targets ES2017 and lacks integration-only `paths`
// overrides, exactly what `crowdReportsLazy.tsx` exists to route around.
import { CrowdApproachPromptLazy } from "@/components/map/crowdReportsLazy";
import { useNavAlerts } from "@/lib/navigation/useNavAlerts";
import { useNavigationEngine } from "@/lib/navigation/useNavigationEngine";
import { NavIncidentsProvider } from "./NavIncidentsProvider";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "https://api.test" }),
}));

let fixHandler: ((fix: FixInput) => void) | null = null;
vi.mock("@/lib/useWatchPosition", () => ({
  useWatchPosition: (_active: boolean, onFix: (f: FixInput) => void) => {
    fixHandler = onFix;
  },
}));
vi.mock("@/lib/navigation/useNavigationVoice", () => ({ useNavigationVoice: () => vi.fn() }));

const fetchDirections = vi.fn();
const fetchRoadConditionsWithStatus = vi.fn();
const fetchRoadAlerts = vi.fn();
const projectEventsToRouteSpy = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchDirections: (...a: unknown[]) => fetchDirections(...a),
    fetchRoadConditionsWithStatus: (...a: unknown[]) => fetchRoadConditionsWithStatus(...a),
    fetchRoadAlerts: (...a: unknown[]) => fetchRoadAlerts(...a),
    useCountryFromCoordinates: () => ({ data: null }),
    projectEventsToRoute: (
      ...a: Parameters<typeof actual.projectEventsToRoute>
    ): ReturnType<typeof actual.projectEventsToRoute> => {
      projectEventsToRouteSpy(...a);
      return actual.projectEventsToRoute(...a);
    },
  };
});

// A straight ~6.82 km west→east route at latitude 52.
const geometry: [number, number][] = [
  [13.0, 52.0],
  [13.1, 52.0],
];
function makeRoute(overrides: Partial<Route> = {}): Route {
  return {
    distance: 6820,
    duration: 400,
    geometry,
    legs: [],
    mode: "driving",
    steps: [{ instruction: "Head east", distance: 6820, duration: 400, coordinates: geometry }],
    ...overrides,
  } as unknown as Route;
}
const route = makeRoute();

/** ~500 m ahead of the route start, ~3 m off the corridor — inside every approach window used below. */
function closureEvent(id: string): RoadConditionEvent {
  return {
    id,
    source: "s",
    provider: "p",
    type: "road_closure",
    severity: "critical",
    geometry: { type: "Point", coordinates: [13.00733, 52.00003] },
    headline: `closure ${id}`,
  };
}

function ok(events: RoadConditionEvent[]) {
  return { ok: true, events };
}
function fail() {
  return { ok: false, events: [] as RoadConditionEvent[] };
}

const alertsBox: { current: ActiveAlert | null } = { current: null };

function EngineHarness() {
  const resource = useNavIncidentResource();
  useNavigationEngine(resource);
  return null;
}

function AlertsHarness() {
  const resource = useNavIncidentResource();
  alertsBox.current = useNavAlerts(resource);
  return null;
}

function Harness() {
  return (
    <NavIncidentsProvider>
      <EngineHarness />
      <AlertsHarness />
      <Suspense fallback={null}>
        <CrowdApproachPromptLazy />
      </Suspense>
    </NavIncidentsProvider>
  );
}

function renderHarness() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <Harness />
    </QueryClientProvider>,
  );
}

const START_WAYPOINTS: [[number, number], [number, number]] = [geometry[0], geometry[1]];

async function flush(times = 3) {
  await act(async () => {
    for (let i = 0; i < times; i++) await Promise.resolve();
  });
}

describe("ground-navigation incident consumers share one resource", () => {
  beforeEach(() => {
    useNavigationStore.getState().stopNavigation();
    useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: true });
    fixHandler = null;
    alertsBox.current = null;
    fetchDirections.mockReset();
    fetchRoadConditionsWithStatus.mockReset();
    fetchRoadAlerts.mockReset().mockResolvedValue([]);
    projectEventsToRouteSpy.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
    useNavigationStore.getState().stopNavigation();
  });

  it("issues exactly one road-conditions request on mount, and one per 120 s refresh", async () => {
    vi.useFakeTimers();
    fetchRoadConditionsWithStatus.mockResolvedValue(ok([]));
    useNavigationStore.getState().startGroundNavigation(route, "driving", START_WAYPOINTS);
    renderHarness();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(fetchRoadConditionsWithStatus).toHaveBeenCalledTimes(1);

    fetchRoadConditionsWithStatus.mockClear();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });
    expect(fetchRoadConditionsWithStatus).toHaveBeenCalledTimes(1);
  });

  it("projects incidents once per successful revision, not once per consumer", async () => {
    fetchRoadConditionsWithStatus.mockResolvedValue(ok([closureEvent("c1")]));
    useNavigationStore.getState().startGroundNavigation(route, "driving", START_WAYPOINTS);
    renderHarness();
    await flush();
    expect(projectEventsToRouteSpy).toHaveBeenCalledTimes(1);
  });

  it("a first-round fetch failure must not arm an empty closure baseline", async () => {
    fetchDirections.mockResolvedValue({ routes: [route], activeRouteIndex: 0 });
    let call = 0;
    fetchRoadConditionsWithStatus.mockImplementation(() =>
      Promise.resolve(call++ === 0 ? fail() : ok([closureEvent("c1")])),
    );
    useNavigationStore.getState().startGroundNavigation(route, "driving", START_WAYPOINTS);
    renderHarness();
    await flush();

    // Establish progress so the closure-reroute effect has something to check against.
    act(() => fixHandler?.({ coords: [13.0, 52.0], accuracy: 5, speed: 0, timestampMs: 1000 }));

    // Force a second round without waiting on the 120 s interval: toggling both
    // settings off and back on flips `fetchEnabled` false→true, which the
    // fetch effect depends on.
    act(() => useSettingsStore.setState({ incidentAlerts: false, avoidIncidents: false }));
    act(() => useSettingsStore.setState({ incidentAlerts: true, avoidIncidents: true }));
    await flush();

    // The closure only exists from this point on — it was part of the FIRST
    // successful baseline, so it must not read as "new" and trigger a reroute.
    expect(fetchDirections).not.toHaveBeenCalledWith(
      expect.objectContaining({ avoidClosures: true }),
    );
  });

  it("a refresh failure retains the previous route's incidents as stale and sets liveDataUnavailable", async () => {
    vi.useFakeTimers();
    fetchRoadConditionsWithStatus.mockResolvedValue(ok([closureEvent("c1")]));
    useNavigationStore.getState().startGroundNavigation(route, "driving", START_WAYPOINTS);
    renderHarness();
    // Zero speed: the coasting driver keeps ticking through the 120 s advance
    // below without ever moving `alongMeters`, so it can't itself push the
    // incident out of range or across a bucket boundary.
    act(() =>
      fixHandler?.({ coords: [13.0, 52.0], accuracy: 5, speed: 0, timestampMs: Date.now() }),
    );
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(alertsBox.current?.alert.id).toBe("c1");

    // The scheduled 120 s refresh — same route, same bucket — fails.
    fetchRoadConditionsWithStatus.mockResolvedValue(fail());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(120_000);
    });

    expect(alertsBox.current?.alert.id).toBe("c1");
    expect(useNavigationStore.getState().liveDataUnavailable).toBe(true);
  });

  it("a route change clears the previous route's incidents before the new response arrives", async () => {
    fetchRoadConditionsWithStatus.mockResolvedValue(ok([closureEvent("c1")]));
    useNavigationStore.getState().startGroundNavigation(route, "driving", START_WAYPOINTS);
    renderHarness();
    act(() => fixHandler?.({ coords: [13.0, 52.0], accuracy: 5, speed: 0, timestampMs: 1000 }));
    await flush();
    expect(alertsBox.current?.alert.id).toBe("c1");

    let releaseSecondRoute: (v: { ok: boolean; events: RoadConditionEvent[] }) => void = () => {};
    const pending = new Promise<{ ok: boolean; events: RoadConditionEvent[] }>((resolve) => {
      releaseSecondRoute = resolve;
    });
    fetchRoadConditionsWithStatus.mockReset();
    fetchRoadConditionsWithStatus.mockReturnValue(pending);

    const routeB = makeRoute({ distance: 9000 });
    act(() =>
      useNavigationStore.getState().startGroundNavigation(routeB, "driving", START_WAYPOINTS),
    );
    act(() => fixHandler?.({ coords: [13.0, 52.0], accuracy: 5, speed: 0, timestampMs: 2000 }));
    await act(async () => {
      await Promise.resolve();
    });

    // The new route's fetch is still pending — the old route's incident must
    // already be gone, not lingering until the new response resolves.
    expect(alertsBox.current?.alert.id).not.toBe("c1");

    releaseSecondRoute(ok([]));
    await flush();
  });
});

describe("useNavIncidents production call sites", () => {
  const REPO_ROOT = resolve(fileURLToPath(import.meta.url), "../../../../../..");
  const ROOTS = ["apps/web/src", "integrations"];
  const SOURCE_SUFFIXES = [".ts", ".tsx", ".js", ".jsx"];
  const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".next", ".turbo", "coverage"]);

  /** Blank out comments and string/template literals so only real code is matched. */
  function codeOnly(source: string): string {
    const out: string[] = [];
    let i = 0;
    while (i < source.length) {
      const c = source[i];
      const next = source[i + 1];
      if (c === "/" && next === "/") {
        while (i < source.length && source[i] !== "\n") {
          out.push(" ");
          i++;
        }
        continue;
      }
      if (c === "/" && next === "*") {
        while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) {
          out.push(source[i] === "\n" ? "\n" : " ");
          i++;
        }
        out.push(" ", " ");
        i += 2;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") {
        out.push(" ");
        i++;
        while (i < source.length && source[i] !== c) {
          if (source[i] === "\\") {
            out.push(" ");
            i++;
          }
          out.push(source[i] === "\n" ? "\n" : " ");
          i++;
        }
        out.push(" ");
        i++;
        continue;
      }
      out.push(c);
      i++;
    }
    return out.join("");
  }

  function productionSources(dir: string, found: string[]): string[] {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) {
        if (SKIP_DIRS.has(entry) || entry.includes("test")) continue;
        productionSources(path, found);
        continue;
      }
      if (entry.includes("test")) continue;
      if (!SOURCE_SUFFIXES.some((s) => entry.endsWith(s))) continue;
      found.push(path);
    }
    return found;
  }

  const files = ROOTS.flatMap((root) => productionSources(join(REPO_ROOT, root), []));
  const referencing = files
    .filter((path) => /\buseNavIncidents\(/.test(codeOnly(readFileSync(path, "utf8"))))
    .map((path) => relative(REPO_ROOT, path).split(sep).join("/"))
    .sort();

  it("calls useNavIncidents() only from its own declaration and the nav-incident provider", () => {
    expect(referencing).toEqual([
      "apps/web/src/components/navigation/NavIncidentsProvider.tsx",
      "apps/web/src/lib/navigation/useNavIncidents.ts",
    ]);
  });

  it("scans a plausible number of sources", () => {
    // Guards against a broken walk quietly passing the gate with nothing to scan.
    expect(files.length).toBeGreaterThan(100);
  });
});
