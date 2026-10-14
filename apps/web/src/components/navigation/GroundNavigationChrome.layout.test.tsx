import type { Route } from "@integrations/routing/types";
import { findJunctionDecisionPoints, useNavigationStore, useSettingsStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useNavJunctionStore } from "@/lib/navigation/junctionStore";
import { installMeasuredLayout } from "@/test/measuredLayout";
import routeFixture from "../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const mapCtx = { fitBounds: vi.fn() };
vi.mock("@/integration-api/map/MapContext", async () => ({
  ...(await vi.importActual<typeof import("@/integration-api/map/MapContext")>(
    "@/integration-api/map/MapContext",
  )),
  useMapOptional: () => mapCtx,
}));

// Keep the actual chrome, junction, speed and bottom-bar consumers; external
// controls/dialogs are irrelevant to the measured photo boundary.
vi.mock("./NavMenu", () => ({ NavMenu: () => null }));
vi.mock("./NavManeuverSlot", () => ({ NavManeuverSlot: () => null }));

vi.mock("./NavOfflineBannerSlot", () => ({ NavOfflineBannerSlot: () => null }));
vi.mock("./NavAlertSlot", () => ({ NavAlertSlot: () => null }));
vi.mock("./NavStatusSlot", () => ({ NavStatusSlot: () => null }));

vi.mock("./FasterRouteBanner", () => ({ FasterRouteBanner: () => null }));
vi.mock("./ArrivalCard", () => ({ ArrivalCard: () => null }));
vi.mock("./NavDirectionsDialog", () => ({ NavDirectionsDialog: () => null }));
vi.mock("./NavPerfControl", () => ({ NavPerfControl: () => null }));
vi.mock("./NavSimControl", () => ({ NavSimControl: () => null }));
vi.mock("./RouteSearchControl", () => ({ RouteSearchControl: () => null }));
vi.mock("@/components/settings/NavigationSettingsDialog", () => ({
  NavigationSettingsDialog: () => null,
}));

const { GroundNavigationChrome } = await import("./GroundNavigationChrome");
const { MobileRuntimeProvider } = await import("@/lib/mobile/MobileRuntimeProvider");

const route = routeFixture.route as unknown as Route;
const points = findJunctionDecisionPoints(route);

it("uses the real measured shell budget to replace an overflowing junction photo with a schematic and restore it", () => {
  let shellHeight = 900;
  const layout = installMeasuredLayout((el) => {
    const marker = el.dataset.testid;
    if (marker === "ground-nav-chrome") return new DOMRect(0, 0, 390, shellHeight);
    if (marker === "ground-nav-bottom") return new DOMRect(0, 10000, 390, 10);
    if (marker === "nav-speed-limit") return new DOMRect(0, 0, 64, 64);
    if (marker === "ground-nav-bottom-header") return new DOMRect(0, 0, 390, 96);
    if (marker === "junction-photo-measurement") return new DOMRect(0, 0, 358, 500);
    const panel = document.querySelector('[data-testid="junction-view-panel"]');
    const hasPhoto = panel?.querySelector(':scope > [role="img"] [data-testid="junction-photo"]');
    const visibleHeight = hasPhoto ? 500 : 240;
    if (marker === "junction-view-panel") return new DOMRect(0, 150, 358, visibleHeight);
    if (marker === "ground-nav-banner") return new DOMRect(0, 0, 390, 150 + visibleHeight + 24);
    return new DOMRect();
  });
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  useSettingsStore.setState({ junctionView: true, junctionPhotos: true });
  useNavigationStore.setState({
    status: "navigating",
    kind: "ground",
    mode: "driving",
    route,
    currentSpeedLimit: 80,
    progress: { currentStepIndex: 0, distanceToNextManeuver: 400, speedMps: 30 } as never,
  });
  useNavJunctionStore.getState().setDecisionPoints("layout-route", points);
  const point = points[0];
  if (!point) throw new Error("Fixture must contain a junction");
  useNavJunctionStore.getState().setPhoto(point.stepIndex, {
    status: "ready",
    objectUrl: "blob:layout",
    image: {
      id: "layout-image",
      providerId: "panoramax",
      lngLat: [6.679, 51.1786],
      heading: 283,
      isPano: false,
      fovDeg: 70,
      assets: {},
      contributors: [
        {
          sourceId: "captured",
          name: "Photographer",
          attributionText: "Full required image notice",
        },
      ],
    },
  });
  try {
    const view = render(
      <QueryClientProvider client={client}>
        <MobileRuntimeProvider webBuildId="web-build-1" scope={{}}>
          <GroundNavigationChrome coverage={{ kind: "not-downloaded", packageIds: [] }} />
        </MobileRuntimeProvider>
      </QueryClientProvider>,
    );
    expect(screen.getByRole("contentinfo").textContent).toContain("Full required image notice");
    act(() => {
      shellHeight = 844;
      layout.resize();
    });
    expect(screen.queryByRole("contentinfo")).toBeNull();
    expect(view.container.querySelector('[data-testid="junction-schematic"]')).not.toBeNull();
    act(() => {
      shellHeight = 300;
      layout.resize();
      layout.resize();
    });
    expect(screen.queryByRole("contentinfo")).toBeNull();
    act(() => {
      shellHeight = 900;
      layout.resize();
    });
    expect(screen.getByRole("contentinfo").textContent).toContain("Full required image notice");
    act(() => useNavigationStore.setState({ route: null }));
    expect(view.container.querySelector('[data-testid="junction-view-panel"]')).toBeNull();
    expect(screen.queryByRole("contentinfo")).toBeNull();
  } finally {
    cleanup();
    layout.restore();
    useNavigationStore.getState().stopNavigation();
    useNavJunctionStore.getState().reset();
  }
});
