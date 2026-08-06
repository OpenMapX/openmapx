// @vitest-environment jsdom

import type { Route } from "@integrations/routing/types";
import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import {
  NavIncidentContext,
  type NavIncidentResource,
} from "@openmapx/integration-framework/react";
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const requestWakeLock = vi.fn();
vi.mock("@/lib/useWakeLock", () => ({
  useWakeLock: (active: boolean) => requestWakeLock(active),
}));

// The engine, camera loop and session persistence pull in geolocation,
// MapLibre and offline-package machinery that is irrelevant to whether
// NavigationView asks for a wake lock — stub them out so this test isolates
// that one wiring decision (the status → useWakeLock argument).
vi.mock("@/lib/navigation/useNavigationEngine", () => ({ useNavigationEngine: () => {} }));
vi.mock("@/lib/navigation/useNavCamera", () => ({ useNavCamera: () => {} }));
vi.mock("@/lib/navigation/useNavAlerts", () => ({ useNavAlerts: () => null }));
vi.mock("@/lib/navigation/useNavigationSessionPersistence", () => ({
  useNavigationSessionPersistence: () => ({
    pending: null,
    coverage: { kind: "not-downloaded", packageIds: [] },
    accept: () => {},
    discard: async () => {},
  }),
}));

// Every child component below is likewise irrelevant to that decision.
vi.mock("./AlertWidget", () => ({ AlertWidget: () => null }));
vi.mock("./ArrivalCard", () => ({ ArrivalCard: () => null }));
vi.mock("./FasterRouteBanner", () => ({ FasterRouteBanner: () => null }));
vi.mock("./ManeuverBanner", () => ({ ManeuverBanner: () => null }));
vi.mock("./NavBottomBar", () => ({ NavBottomBar: () => null }));
vi.mock("./NavDirectionsDialog", () => ({ NavDirectionsDialog: () => null }));
vi.mock("./NavigationSessionResumeDialog", () => ({ NavigationSessionResumeDialog: () => null }));
vi.mock("./NavMenu", () => ({ NavMenu: () => null }));
vi.mock("./NavPerfControl", () => ({ NavPerfControl: () => null }));
vi.mock("./NavSimControl", () => ({ NavSimControl: () => null }));
vi.mock("./NavSwipeSheet", () => ({ NavSwipeSheet: () => null }));
vi.mock("./OfflineNavigationBanner", () => ({ OfflineNavigationBanner: () => null }));
vi.mock("./RouteSearchControl", () => ({ RouteSearchControl: () => null }));
vi.mock("./SpeedLimitBadge", () => ({ SpeedLimitBadge: () => null }));
vi.mock("@/components/settings/NavigationSettingsDialog", () => ({
  NavigationSettingsDialog: () => null,
}));

import { NavigationView } from "./NavigationView";

const INCIDENT_RESOURCE: NavIncidentResource = {
  incidents: [],
  status: "disabled",
  routeIdentity: null,
  successfulRevision: 0,
};

const route = {
  distance: 1000,
  duration: 200,
  geometry: [
    [0, 0],
    [0.01, 0],
  ] as [number, number][],
  legs: [],
  steps: [],
  mode: "driving" as const,
  summary: "via test",
} as unknown as Route;

function renderNavigationView() {
  return render(
    <NavIncidentContext.Provider value={INCIDENT_RESOURCE}>
      <NavigationView />
    </NavIncidentContext.Provider>,
  );
}

/**
 * Whether a wake lock is currently being held — `false` covers both "called
 * with false" and "never called at all" (idle and transit navigation no
 * longer mount the runtime that calls `useWakeLock` at all).
 */
function wakeLockHeld(): boolean {
  return (requestWakeLock.mock.calls.at(-1)?.[0] as boolean | undefined) ?? false;
}

describe("NavigationView — wake lock follows live navigation status", () => {
  beforeEach(() => {
    requestWakeLock.mockClear();
    useNavigationStore.getState().stopNavigation();
    useNavigationStore.setState({ keepScreenOn: true });
    useSettingsStore.setState({ units: "metric" });
  });

  afterEach(() => {
    useNavigationStore.getState().stopNavigation();
  });

  it("does not request a wake lock before navigation starts", () => {
    renderNavigationView();
    expect(wakeLockHeld()).toBe(false);
  });

  it("requests a wake lock while navigating", () => {
    renderNavigationView();
    act(() => {
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.01, 0],
      ]);
    });
    expect(wakeLockHeld()).toBe(true);
  });

  it("holds the wake lock through a reroute", () => {
    renderNavigationView();
    act(() => {
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.01, 0],
      ]);
    });
    act(() => {
      useNavigationStore.getState().beginReroute();
    });
    expect(wakeLockHeld()).toBe(true);
  });

  it("releases the wake lock on arrival — the arrival card stays, but live sensors and rendering are done", () => {
    renderNavigationView();
    act(() => {
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.01, 0],
      ]);
    });
    expect(wakeLockHeld()).toBe(true);
    act(() => {
      useNavigationStore.getState().completeArrival();
    });
    expect(wakeLockHeld()).toBe(false);
  });

  it("never requests a wake lock for transit navigation (kind !== 'ground')", () => {
    renderNavigationView();
    act(() => {
      useNavigationStore.setState({ status: "navigating", kind: "transit" });
    });
    expect(wakeLockHeld()).toBe(false);
  });

  it("does not request a wake lock while navigating if keepScreenOn is off", () => {
    useNavigationStore.setState({ keepScreenOn: false });
    renderNavigationView();
    act(() => {
      useNavigationStore.getState().startGroundNavigation(route, "driving", [
        [0, 0],
        [0.01, 0],
      ]);
    });
    expect(wakeLockHeld()).toBe(false);
  });
});
