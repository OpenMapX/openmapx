// @vitest-environment jsdom

// Characterizes NavigationView's current render behavior before it is split by
// update cadence: everything below documents what happens TODAY, including the
// parts that are the target of the coming refactor. The cold-rerender
// assertions are written against the desired end state and are expected to
// fail against the current, undivided component — that failure is the point of
// this file, not a bug to chase here.

import type { Route } from "@integrations/routing/types";
import {
  createNavigationSessionSnapshot,
  type NavigationSessionSnapshot,
  type NavProgress,
  upcomingManeuverIndex,
  useNavigationStore,
  useSettingsStore,
} from "@openmapx/core";
import {
  NavIncidentContext,
  type NavIncidentResource,
} from "@openmapx/integration-framework/react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OfflineRouteCoverage } from "@/lib/navigation/offlineRouteCoverage";
import type { NavMenuProps } from "./NavMenu";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

vi.mock("@/lib/useWakeLock", () => ({ useWakeLock: () => {} }));
vi.mock("@/lib/navigation/useNavigationEngine", () => ({ useNavigationEngine: () => {} }));
vi.mock("@/lib/navigation/useNavCamera", () => ({ useNavCamera: () => {} }));
vi.mock("@/lib/navigation/useNavAlerts", () => ({ useNavAlerts: () => null }));

// Mutable so individual tests can flip the pending-session-resume case without
// re-declaring the whole module mock. Referenced only from inside the factory's
// returned hook body, which runs on first import of the mocked module — well
// after this `const` has been assigned.
const sessionMockState: {
  pending: NavigationSessionSnapshot | null;
  coverage: OfflineRouteCoverage;
} = {
  pending: null,
  coverage: { kind: "not-downloaded", packageIds: [] },
};
vi.mock("@/lib/navigation/useNavigationSessionPersistence", () => ({
  useNavigationSessionPersistence: () => ({
    pending: sessionMockState.pending,
    coverage: sessionMockState.coverage,
    accept: () => {},
    discard: async () => {},
  }),
}));

// Same pattern for the mobile/desktop breakpoint: default to desktop so the
// bulk of this file exercises the Collapse-based menu/dialog path rather than
// the (separately mocked) NavSwipeSheet.
const mediaQueryState = { isMobile: false };
vi.mock("@mui/material/useMediaQuery", () => ({
  default: () => mediaQueryState.isMobile,
}));

// The real Collapse schedules its enter/exit transition on a measured-height
// timeout, which in jsdom (zero layout) fires asynchronously well after a
// synchronous act() returns — producing spurious "not wrapped in act"
// warnings with no bearing on what this file measures. A boolean-gated
// passthrough keeps the real mount/unmount-on-`in` semantics NavigationView
// relies on without the animation plumbing.
vi.mock("@mui/material/Collapse", () => ({
  default: ({ in: open, children }: { in: boolean; children?: ReactNode }) =>
    open ? children : null,
}));

const renderCounts: Record<string, number> = {};
function countRender(name: string) {
  renderCounts[name] = (renderCounts[name] ?? 0) + 1;
}
function resetRenderCounts() {
  for (const key of Object.keys(renderCounts)) renderCounts[key] = 0;
}
function renderCount(name: string): number {
  return renderCounts[name] ?? 0;
}

interface ManeuverBannerSpyProps {
  instruction: string;
  distanceToManeuver: number;
  units: "metric" | "imperial";
}
let lastManeuverBannerProps: ManeuverBannerSpyProps | null = null;
vi.mock("./ManeuverBanner", () => ({
  ManeuverBanner: (props: ManeuverBannerSpyProps) => {
    countRender("ManeuverBanner");
    lastManeuverBannerProps = props;
    return null;
  },
}));

vi.mock("./NavStatusSlot", async () => {
  const actual = await vi.importActual<typeof import("./NavStatusSlot")>("./NavStatusSlot");
  return {
    NavStatusSlot: () => {
      countRender("NavStatusSlot");
      return actual.NavStatusSlot();
    },
  };
});

interface NavBottomBarSpyProps {
  distanceRemaining?: number;
  durationRemaining: number;
  etaEpochMs: number;
  menuToggle?: ReactNode;
}
let lastNavBottomBarProps: NavBottomBarSpyProps | null = null;
vi.mock("./NavBottomBar", () => ({
  // Forwards `menuToggle` into the DOM (unlike every other spy here, which
  // renders nothing) because the desktop chevron button lives only inside that
  // prop — tests that need to open the menu must be able to click it.
  NavBottomBar: (props: NavBottomBarSpyProps) => {
    countRender("NavBottomBar");
    lastNavBottomBarProps = props;
    return props.menuToggle ?? null;
  },
}));

interface SpeedLimitBadgeSpyProps {
  speedLimit: number | null;
  units: "metric" | "imperial";
}
let lastSpeedLimitBadgeProps: SpeedLimitBadgeSpyProps | null = null;
vi.mock("./SpeedLimitBadge", () => ({
  SpeedLimitBadge: (props: SpeedLimitBadgeSpyProps) => {
    countRender("SpeedLimitBadge");
    lastSpeedLimitBadgeProps = props;
    return null;
  },
}));

vi.mock("./RouteSearchControl", () => ({
  RouteSearchControl: () => {
    countRender("RouteSearchControl");
    return null;
  },
}));

interface NavDirectionsDialogSpyProps {
  open: boolean;
  route: Route;
}
let lastNavDirectionsDialogProps: NavDirectionsDialogSpyProps | null = null;
vi.mock("./NavDirectionsDialog", () => ({
  NavDirectionsDialog: (props: NavDirectionsDialogSpyProps) => {
    countRender("NavDirectionsDialog");
    lastNavDirectionsDialogProps = props;
    return null;
  },
}));

vi.mock("@/components/settings/NavigationSettingsDialog", () => ({
  NavigationSettingsDialog: () => {
    countRender("NavigationSettingsDialog");
    return null;
  },
}));

vi.mock("./NavMenu", () => ({
  // Renders one real button wired to `onOpenDirections` so tests can open the
  // directions dialog the same way a driver would — through the menu — without
  // depending on NavMenu's real row markup (mocked away like every other child).
  NavMenu: (props: NavMenuProps) => {
    countRender("NavMenu");
    return (
      <button type="button" data-testid="test-open-directions" onClick={props.onOpenDirections}>
        open-directions
      </button>
    );
  },
}));

vi.mock("./ArrivalCard", () => ({
  ArrivalCard: () => {
    countRender("ArrivalCard");
    return null;
  },
}));

vi.mock("./NavigationSessionResumeDialog", () => ({
  NavigationSessionResumeDialog: () => {
    countRender("NavigationSessionResumeDialog");
    return null;
  },
}));

vi.mock("./NavSwipeSheet", () => ({
  NavSwipeSheet: () => {
    countRender("NavSwipeSheet");
    return null;
  },
}));

vi.mock("./AlertWidget", () => ({ AlertWidget: () => null }));
vi.mock("./FasterRouteBanner", () => ({ FasterRouteBanner: () => null }));
vi.mock("./OfflineNavigationBanner", () => ({ OfflineNavigationBanner: () => null }));
vi.mock("./NavPerfControl", () => ({ NavPerfControl: () => null }));
vi.mock("./NavSimControl", () => ({ NavSimControl: () => null }));

import { NavigationView } from "./NavigationView";

const INCIDENT_RESOURCE: NavIncidentResource = {
  incidents: [],
  status: "disabled",
  routeIdentity: null,
  successfulRevision: 0,
};

const BASE_TIME_MS = Date.UTC(2026, 0, 1, 12, 0, 0);

/** A route with real steps (unlike a `steps: []` fixture) so ManeuverBanner has something to show. */
function buildRoute(): Route {
  return {
    distance: 5000,
    duration: 600,
    geometry: [
      [0, 0],
      [0.01, 0],
      [0.02, 0],
      [0.03, 0],
    ],
    legs: [],
    steps: [
      {
        instruction: "Head north on Main St",
        distance: 500,
        duration: 60,
        coordinates: [
          [0, 0],
          [0.005, 0],
        ],
        maneuver: { type: "depart" },
      },
      {
        instruction: "Turn right onto Oak Ave",
        distance: 800,
        duration: 90,
        coordinates: [
          [0.005, 0],
          [0.015, 0],
        ],
        maneuver: { type: "turn", modifier: "right" },
        lanes: [{ indications: ["through", "right"], valid: true, active: "right" }],
      },
      {
        instruction: "Arrive at destination",
        distance: 200,
        duration: 30,
        coordinates: [
          [0.015, 0],
          [0.03, 0],
        ],
        maneuver: { type: "arrive" },
      },
    ],
    mode: "driving",
    summary: "via Main St",
  };
}

/**
 * One synthetic fix's worth of progress. Every numeric field is a function of
 * `i` so React never bails out on referential/value equality across the 100
 * calls, and `currentStepIndex` stays 0 throughout so the displayed maneuver
 * (`route.steps[upcomingManeuverIndex(0, …)]`) is stable and predictable.
 */
function buildProgress(i: number): NavProgress {
  return {
    currentStepIndex: 0,
    distanceToNextManeuver: 800 - i * 5,
    distanceRemaining: 5000 - i * 10,
    durationRemaining: 600 - i * 3,
    snapped: [0.001 * i, 0],
    alongMeters: i * 10,
    deviationMeters: 0,
    segmentIndex: 0,
    etaEpochMs: BASE_TIME_MS + i * 1000,
    bearing: 90,
    speedMps: 10 + (i % 5),
  };
}

function renderNavigationView() {
  return render(
    <NavIncidentContext.Provider value={INCIDENT_RESOURCE}>
      <NavigationView />
    </NavIncidentContext.Provider>,
  );
}

function startNav(route: Route) {
  act(() => {
    useNavigationStore
      .getState()
      .startGroundNavigation(route, "driving", [route.geometry[0], route.geometry[3]]);
  });
}

/** Publishes fix `i` through the same single-update-per-fix action the real engine uses. */
function applyProgressOnlyFix(i: number) {
  act(() => {
    useNavigationStore.getState().applyGroundFix({
      progress: buildProgress(i),
      weakGps: false,
      offRoute: false,
      currentSpeedLimit: 50,
      coasting: false,
    });
  });
}

function runHundredProgressOnlyFixes() {
  for (let i = 0; i < 100; i++) applyProgressOnlyFix(i);
}

/** Opens the desktop menu via the real chevron button forwarded by the NavBottomBar spy. */
function openDesktopMenu() {
  fireEvent.click(screen.getByLabelText("navigation.moreOptions"));
}

function buildSessionSnapshot(route: Route): NavigationSessionSnapshot {
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
    destinationWaypoints: [route.geometry[0], route.geometry[3]],
    progress: null,
    packageIds: [],
    startedAtMs: BASE_TIME_MS,
    updatedAtMs: BASE_TIME_MS,
  });
}

beforeEach(() => {
  useNavigationStore.getState().stopNavigation();
  useSettingsStore.setState({ units: "metric" });
  mediaQueryState.isMobile = false;
  sessionMockState.pending = null;
  sessionMockState.coverage = { kind: "not-downloaded", packageIds: [] };
  resetRenderCounts();
  lastManeuverBannerProps = null;
  lastNavBottomBarProps = null;
  lastSpeedLimitBadgeProps = null;
  lastNavDirectionsDialogProps = null;
});

afterEach(() => {
  useNavigationStore.getState().stopNavigation();
});

describe("navigation render boundaries — hot slots update on every accepted fix", () => {
  it("renders ManeuverBanner, NavBottomBar and SpeedLimitBadge exactly once per fix, ending on the final values", () => {
    const route = buildRoute();
    renderNavigationView();
    startNav(route);
    resetRenderCounts();

    runHundredProgressOnlyFixes();

    expect(renderCount("ManeuverBanner")).toBe(100);
    expect(renderCount("NavBottomBar")).toBe(100);
    // SpeedLimitBadge only starts existing once `currentSpeedLimit` goes
    // non-null on the first fix, so its mount is fix #1 and its 100th render
    // call lands on fix #100 — still an exact delta of 100 from the 0 baseline.
    expect(renderCount("SpeedLimitBadge")).toBe(100);

    const finalProgress = buildProgress(99);

    const maneuverProps = lastManeuverBannerProps;
    if (!maneuverProps) throw new Error("ManeuverBanner never rendered");
    expect(maneuverProps.distanceToManeuver).toBe(finalProgress.distanceToNextManeuver);
    expect(maneuverProps.units).toBe("metric");

    const bottomBarProps = lastNavBottomBarProps;
    if (!bottomBarProps) throw new Error("NavBottomBar never rendered");
    expect(bottomBarProps.distanceRemaining).toBe(finalProgress.distanceRemaining);
    expect(bottomBarProps.durationRemaining).toBe(finalProgress.durationRemaining);
    expect(bottomBarProps.etaEpochMs).toBe(finalProgress.etaEpochMs);

    const speedBadgeProps = lastSpeedLimitBadgeProps;
    if (!speedBadgeProps) throw new Error("SpeedLimitBadge never rendered");
    expect(speedBadgeProps.speedLimit).toBe(50);
    expect(speedBadgeProps.units).toBe("metric");
  });
});

describe("navigation render boundaries — cold components do not rerender per fix", () => {
  it("leaves RouteSearchControl, the open NavMenu, and the closed dialogs untouched by 100 progress-only fixes", () => {
    const route = buildRoute();
    renderNavigationView();
    startNav(route);
    // Mount NavMenu (via the open desktop menu) so its count is a real
    // before/after delta rather than a vacuous zero from never mounting.
    // NavDirectionsDialog and NavigationSettingsDialog stay closed, matching
    // the "closed dialogs shouldn't rerender" scenario this guards.
    openDesktopMenu();
    resetRenderCounts();

    runHundredProgressOnlyFixes();

    // EXPECTED TO FAIL today: NavigationView is one undivided component, so
    // every progress-only fix re-renders the whole tree, including these four.
    expect(renderCount("RouteSearchControl")).toBe(0);
    expect(renderCount("NavMenu")).toBe(0);
    expect(renderCount("NavDirectionsDialog")).toBe(0);
    expect(renderCount("NavigationSettingsDialog")).toBe(0);
  });
});

describe("navigation render boundaries — ARIA live warnings are immediate", () => {
  it("announces the coasting estimated-position text in the same act() as the state change", () => {
    renderNavigationView();
    startNav(buildRoute());

    act(() => {
      useNavigationStore.setState({ progress: buildProgress(0), coasting: true, weakGps: false });
    });

    expect(screen.getByText("navigation.estimatedPosition")).toBeDefined();
  });

  it("announces the weak-GPS text in the same act() as the state change", () => {
    renderNavigationView();
    startNav(buildRoute());

    act(() => {
      useNavigationStore.setState({ progress: buildProgress(0), weakGps: true, coasting: false });
    });

    expect(screen.getByText("navigation.weakGps")).toBeDefined();
  });

  it("announces the rerouting text in the same act() as the status change", () => {
    renderNavigationView();
    startNav(buildRoute());

    act(() => {
      useNavigationStore.getState().beginReroute();
    });

    expect(screen.getByText("navigation.rerouting")).toBeDefined();
  });
});

describe("navigation render boundaries — NavStatusSlot subscribes to a derived boolean, not the progress object", () => {
  it("re-renders exactly once across 100 progress-only fixes — the transition when the first fix clears awaitingFix", () => {
    const route = buildRoute();
    renderNavigationView();
    startNav(route);
    resetRenderCounts();

    runHundredProgressOnlyFixes();

    // Exactly 1, not 0: at mount `progress` is still null, so `awaitingFix` is
    // true and NavStatusSlot renders its notice. Fix #1 flips `awaitingFix` to
    // false — the one selector-value change in the run — and fixes #2-100
    // leave it false, so no further renders follow. A future reader tightening
    // this to `toBe(0)` would be masking a real, expected transition.
    expect(renderCount("NavStatusSlot")).toBe(1);
  });
});

describe("navigation render boundaries — static-route fallback before the first fix", () => {
  it("shows the route's own distance/duration and the upcoming step's distance while progress is still null", () => {
    const route = buildRoute();
    renderNavigationView();
    startNav(route);

    expect(useNavigationStore.getState().progress).toBeNull();

    const expectedStep = route.steps[upcomingManeuverIndex(0, route.steps.length)];
    const maneuverProps = lastManeuverBannerProps;
    if (!maneuverProps) throw new Error("ManeuverBanner never rendered");
    expect(maneuverProps.distanceToManeuver).toBe(expectedStep.distance);
    expect(maneuverProps.instruction).toBe(expectedStep.instruction);

    const bottomBarProps = lastNavBottomBarProps;
    if (!bottomBarProps) throw new Error("NavBottomBar never rendered");
    expect(bottomBarProps.distanceRemaining).toBe(route.distance);
    expect(bottomBarProps.durationRemaining).toBe(route.duration);
  });
});

describe("navigation render boundaries — menu/dialog state survives a progress run", () => {
  it("keeps the directions dialog open on the current route after 100 progress-only fixes", () => {
    const route = buildRoute();
    renderNavigationView();
    startNav(route);
    openDesktopMenu();
    fireEvent.click(screen.getByTestId("test-open-directions"));

    const openedProps = lastNavDirectionsDialogProps;
    if (!openedProps) throw new Error("NavDirectionsDialog never rendered");
    expect(openedProps.open).toBe(true);

    runHundredProgressOnlyFixes();

    const finalProps = lastNavDirectionsDialogProps;
    if (!finalProps) throw new Error("NavDirectionsDialog never rendered");
    expect(finalProps.open).toBe(true);
    expect(finalProps.route).toBe(useNavigationStore.getState().route);
    // The menu itself (proxied by its fake open-directions button) is still mounted.
    expect(screen.getByTestId("test-open-directions")).toBeDefined();
  });
});

describe("navigation render boundaries — arrival and resume roots", () => {
  it("mounts ArrivalCard and stops rendering the hot guidance slots on arrival", () => {
    renderNavigationView();
    startNav(buildRoute());
    expect(renderCount("ManeuverBanner")).toBeGreaterThan(0);
    resetRenderCounts();

    act(() => {
      useNavigationStore.getState().completeArrival();
    });

    // Two passes, not one: the guidance banner carries the callback ref that
    // holds the measured map obstruction, so unmounting it commits a second
    // pass over the arrival branch. Arrival happens once per trip; what this
    // guards is that no *fix* reaches the arrival root, which the two zeroes
    // below still pin.
    expect(renderCount("ArrivalCard")).toBe(2);
    expect(renderCount("ManeuverBanner")).toBe(0);
    expect(renderCount("NavBottomBar")).toBe(0);
  });

  it("shows only the resume dialog while idle with a pending session snapshot, mounting no guidance tree", () => {
    sessionMockState.pending = buildSessionSnapshot(buildRoute());

    renderNavigationView();

    // >= 1 rather than an exact 1: a mount-time effect (the `vh` resize
    // listener setup) triggers one extra post-mount render pass unrelated to
    // this component's own logic — brittle to pin exactly, per the note above
    // about Strict-Mode-style mount probes.
    expect(renderCount("NavigationSessionResumeDialog")).toBeGreaterThanOrEqual(1);
    expect(renderCount("ManeuverBanner")).toBe(0);
    expect(renderCount("NavBottomBar")).toBe(0);
    expect(renderCount("ArrivalCard")).toBe(0);
    expect(renderCount("RouteSearchControl")).toBe(0);
  });
});

describe("navigation render boundaries — mobile vs desktop chrome", () => {
  it("mounts NavSwipeSheet when the mobile breakpoint matches", () => {
    mediaQueryState.isMobile = true;
    renderNavigationView();
    startNav(buildRoute());

    expect(renderCount("NavSwipeSheet")).toBeGreaterThanOrEqual(1);
  });

  it("mounts the desktop panel (NavBottomBar directly, no NavSwipeSheet) when the mobile breakpoint doesn't match", () => {
    mediaQueryState.isMobile = false;
    renderNavigationView();
    startNav(buildRoute());

    expect(renderCount("NavBottomBar")).toBeGreaterThanOrEqual(1);
    expect(renderCount("NavSwipeSheet")).toBe(0);
  });
});
