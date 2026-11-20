import { type DirectionsResult, useDirectionsStore, useSidebarStore } from "@openmapx/core";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test";
import { DirectionsPanelContent } from "./DirectionsPanelContent";

vi.mock("next-intl", async () =>
  (await import("@/test/intl")).mockNextIntl({ useLocale: () => "de" }),
);

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ flyTo: vi.fn() }),
  useMapOptional: () => null,
}));

vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: null, isPending: false, error: null }),
}));

const BERLIN: [number, number] = [13.3, 52.5];
const LEIPZIG: [number, number] = [12.37, 51.34];
const MUNICH: [number, number] = [11.5, 48.1];

let resolveOptimize: ((response: Response) => void) | null = null;
let queryClient = createTestQueryClient();

function drivenRoute(): DirectionsResult {
  return {
    waypoints: [],
    routes: [
      {
        mode: "driving",
        duration: 3600,
        distance: 120000,
        legs: [],
        steps: [],
        geometry: [],
      },
    ],
    activeRouteIndex: 0,
  } as unknown as DirectionsResult;
}

beforeEach(() => {
  resolveOptimize = null;
  queryClient = createTestQueryClient();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    switch (url.pathname) {
      case "/api/integrations/routing/directions/optimize":
        return new Promise<Response>((resolve) => {
          resolveOptimize = resolve;
        });
      case "/api/integrations/routing/directions":
        return Response.json(drivenRoute());
      case "/api/integrations/transit/planning-capabilities":
        return Response.json({ providers: [] });
      case "/api/integrations/geocoding/geocode/country":
        return Response.json({ countryCode: null });
      case "/api/integrations/data-source/fuel/search":
        return Response.json({ data: [], attributions: [] });
      case "/api/capabilities":
        return Response.json({ services: {} });
      default:
        return Response.json({ error: "not stubbed" }, { status: 404 });
    }
  });
  act(() => {
    useDirectionsStore.getState().close();
    useDirectionsStore.getState().setMode("driving");
    useSidebarStore.setState({ activeSidebarId: null });
    useDirectionsStore.getState().setWaypoint(0, BERLIN, "Berlin");
    useDirectionsStore.getState().setWaypoint(1, MUNICH, "Munich");
    useDirectionsStore.getState().insertWaypoint(1, LEIPZIG, "Leipzig");
  });
});

afterEach(() => vi.unstubAllGlobals());

const labels = () => useDirectionsStore.getState().waypoints.map((wp) => wp.label);

it("applies an Optimize answer that lands while the route details are open", async () => {
  render(<DirectionsPanelContent />, { wrapper: createQueryWrapper(queryClient) });
  fireEvent.click(screen.getByRole("button", { name: /directions.optimizeStopOrder/ }));
  await waitFor(() => expect(resolveOptimize).not.toBeNull());

  fireEvent.click(await screen.findByRole("button", { name: "common.details" }));
  await screen.findByRole("button", { name: "common.back" });
  expect(screen.queryByRole("button", { name: /directions.optimiz/ })).toBeNull();

  await act(async () => {
    resolveOptimize?.(
      Response.json({ waypoints: [], routes: [], activeRouteIndex: 0, optimizedOrder: [0, 2, 1] }),
    );
  });
  await waitFor(() =>
    expect(queryClient.getMutationCache().getAll()[0]?.state.status).toBe("success"),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));

  expect(labels()).toEqual(["Berlin", "Munich", "Leipzig"]);
  fireEvent.click(screen.getByRole("button", { name: "common.back" }));
  expect((await screen.findByRole("alert")).textContent).toBe("directions.routeOptimized");
});
