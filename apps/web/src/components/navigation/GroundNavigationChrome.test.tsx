import type { Route } from "@integrations/routing/types";
import { useDirectionsStore, useNavigationStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const mapCtx = { fitBounds: vi.fn() };
vi.mock("@/integration-api/map/MapContext", async () => ({
  ...(await vi.importActual<typeof import("@/integration-api/map/MapContext")>(
    "@/integration-api/map/MapContext",
  )),
  useMapOptional: () => mapCtx,
}));

// What the overview action does to the camera is the whole subject here, so the
// menu is reduced to the row that triggers it and the panel to the toggle that
// reveals the menu. Every slot and dialog around them is covered on its own.
vi.mock("./NavMenu", () => ({
  NavMenu: ({ onOverview }: { onOverview: () => void }) => (
    <button type="button" onClick={onOverview}>
      overview
    </button>
  ),
}));
vi.mock("./NavBottomBarSlot", () => ({
  NavBottomBarSlot: ({ menuToggle }: { menuToggle?: ReactNode }) => <div>{menuToggle}</div>,
}));
vi.mock("./NavManeuverSlot", () => ({ NavManeuverSlot: () => null }));
vi.mock("./NavOfflineBannerSlot", () => ({ NavOfflineBannerSlot: () => null }));
vi.mock("./NavAlertSlot", () => ({ NavAlertSlot: () => null }));
vi.mock("./NavStatusSlot", () => ({ NavStatusSlot: () => null }));
vi.mock("./NavSpeedLimitSlot", () => ({ NavSpeedLimitSlot: () => null }));
vi.mock("./FasterRouteBanner", () => ({ FasterRouteBanner: () => null }));
const arrivalProps = vi.hoisted(() => ({ destinationName: null as string | null }));
vi.mock("./ArrivalCard", () => ({
  ArrivalCard: ({ destinationName }: { destinationName?: string | null }) => {
    arrivalProps.destinationName = destinationName ?? null;
    return null;
  },
}));
vi.mock("./NavDirectionsDialog", () => ({ NavDirectionsDialog: () => null }));
vi.mock("./NavPerfControl", () => ({ NavPerfControl: () => null }));
vi.mock("./NavSimControl", () => ({ NavSimControl: () => null }));
vi.mock("./RouteSearchControl", () => ({ RouteSearchControl: () => null }));
vi.mock("@/components/settings/NavigationSettingsDialog", () => ({
  NavigationSettingsDialog: () => null,
}));

const { GroundNavigationChrome } = await import("./GroundNavigationChrome");
const { MobileRuntimeProvider } = await import("@/lib/mobile/MobileRuntimeProvider");

const route = {
  geometry: [
    [8, 50],
    [8.1, 50.1],
  ],
} as unknown as Route;

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileRuntimeProvider webBuildId="web-build-1" scope={{}}>
        <GroundNavigationChrome coverage={{ kind: "not-downloaded", packageIds: [] }} />
      </MobileRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("GroundNavigationChrome overview", () => {
  beforeEach(() => {
    mapCtx.fitBounds.mockClear();
    useNavigationStore.setState({ status: "navigating", kind: "ground", route });
  });
  afterEach(() => {
    cleanup();
    useNavigationStore.getState().stopNavigation();
  });

  it("frames the whole route north-up and level", () => {
    const view = mount();
    fireEvent.click(view.getByLabelText("navigation.moreOptions"));
    fireEvent.click(view.getByText("overview"));

    // A route overview is read like a map, whatever pose the follow camera was
    // holding — and the framing only straightens and levels when it is asked to.
    expect(mapCtx.fitBounds).toHaveBeenCalledWith(
      [
        [8, 50],
        [8.1, 50.1],
      ],
      64,
      { bearing: 0, pitch: 0 },
    );
    expect(useNavigationStore.getState().cameraMode).toBe("overview");
  });
});

describe("GroundNavigationChrome arrival metadata", () => {
  beforeEach(() => {
    arrivalProps.destinationName = null;
    useNavigationStore.setState({
      status: "arrived",
      kind: "ground",
      mode: "driving",
      route,
      destinationWaypoints: [
        [8, 50],
        [8.1, 50.1],
      ],
    });
  });

  afterEach(() => {
    cleanup();
    useNavigationStore.getState().stopNavigation();
    useDirectionsStore.getState().close();
  });

  it("keeps the destination label when its waypoint matches the active session", () => {
    useDirectionsStore.setState({
      waypoints: [
        { id: "a", coords: [8, 50], label: "Start", type: "origin" },
        { id: "b", coords: [8.1, 50.1], label: "Museum", type: "destination" },
      ],
    });

    mount();

    expect(arrivalProps.destinationName).toBe("Museum");
  });

  it("rejects a stale label from a different directions request", () => {
    useDirectionsStore.setState({
      waypoints: [
        { id: "a", coords: [8, 50], label: "Start", type: "origin" },
        { id: "b", coords: [9, 51], label: "Wrong place", type: "destination" },
      ],
    });

    mount();

    expect(arrivalProps.destinationName).toBeNull();
  });
});
