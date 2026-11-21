import { type DirectionsResult, useDirectionsStore, useSidebarStore } from "@openmapx/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  nth,
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

interface Deferred {
  resolve: (response: Response) => void;
}

const BERLIN: [number, number] = [13.3, 52.5];
const LEIPZIG: [number, number] = [12.37, 51.34];
const MUNICH: [number, number] = [11.5, 48.1];
const DRESDEN: [number, number] = [13.74, 51.05];

let optimizeRequests: { url: URL; reply: Deferred }[] = [];
let queryClient = createTestQueryClient();

function emptyRoute(): DirectionsResult {
  return { waypoints: [], routes: [], activeRouteIndex: 0 };
}

beforeEach(() => {
  optimizeRequests = [];
  queryClient = createTestQueryClient();
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    switch (url.pathname) {
      case "/api/integrations/routing/directions/optimize":
        return new Promise<Response>((resolve) => {
          optimizeRequests.push({ url, reply: { resolve } });
        });
      case "/api/integrations/routing/directions":
        return Response.json(emptyRoute());
      case "/api/integrations/transit/planning-capabilities":
        return Response.json({ providers: [] });
      case "/api/integrations/geocoding/geocode/country":
        return Response.json({ countryCode: null });
      case "/api/integrations/data-source/fuel/search":
        return Response.json({ data: [], attributions: [] });
      case "/api/capabilities":
        return Response.json({ services: {} });
      default:
        throw new TypeError(`Unexpected request in the Optimize test: ${url.pathname}`);
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
const inputValues = () =>
  screen.getAllByRole("textbox").map((input) => (input as HTMLInputElement).value);

async function startOptimize() {
  render(<DirectionsPanelContent />, { wrapper: createQueryWrapper(queryClient) });
  fireEvent.click(screen.getByRole("button", { name: /directions.optimizeStopOrder/ }));
  await waitFor(() => expect(optimizeRequests).toHaveLength(1));
  return nth(optimizeRequests, 0);
}

/** Answers the pending request and waits until the mutation and its callbacks have settled. */
async function answer(request: { reply: Deferred }, response: Response) {
  await act(async () => {
    request.reply.resolve(response);
  });
  await waitFor(() =>
    expect(queryClient.getMutationCache().getAll()[0]?.state.status).toMatch(/success|error/),
  );
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

describe("Optimize through the real mutation", () => {
  it("sends the filled stops in their current order with the active mode", async () => {
    const request = await startOptimize();

    expect(request.url.searchParams.get("waypoints")).toBe(
      [BERLIN, LEIPZIG, MUNICH].map(([lng, lat]) => `${lng},${lat}`).join(";"),
    );
    expect(request.url.searchParams.get("mode")).toBe("driving");
  });

  it("moves each stop with its label to the optimized position", async () => {
    const request = await startOptimize();

    await answer(request, Response.json({ ...emptyRoute(), optimizedOrder: [0, 2, 1] }));

    expect((await screen.findByRole("alert")).textContent).toBe("directions.routeOptimized");
    expect(labels()).toEqual(["Berlin", "Munich", "Leipzig"]);
    expect(inputValues()).toEqual(["Berlin", "Munich", "Leipzig"]);
  });

  it("keeps the order and reports a failed optimization", async () => {
    const request = await startOptimize();

    await answer(request, Response.json({ error: "upstream" }, { status: 502 }));

    expect((await screen.findByRole("alert")).textContent).toBe("directions.noRoutesFound");
    expect(labels()).toEqual(["Berlin", "Leipzig", "Munich"]);
    expect(inputValues()).toEqual(["Berlin", "Leipzig", "Munich"]);
  });

  it.each([
    {
      edit: "replacing the middle stop",
      change: () => useDirectionsStore.getState().setWaypoint(1, DRESDEN, "Dresden"),
      expected: ["Berlin", "Dresden", "Munich"],
    },
    {
      edit: "reversing the stops",
      change: () => useDirectionsStore.getState().reverseWaypoints(),
      expected: ["Munich", "Leipzig", "Berlin"],
    },
    {
      edit: "moving a stop",
      change: () => useDirectionsStore.getState().reorderWaypoints(2, 1),
      expected: ["Berlin", "Munich", "Leipzig"],
    },
  ])(
    "ignores an answer for the old stops after $edit while pending",
    async ({ change, expected }) => {
      const request = await startOptimize();

      act(change);
      await answer(request, Response.json({ ...emptyRoute(), optimizedOrder: [2, 0, 1] }));

      expect(inputValues()).toEqual(expected);
      expect(labels()).toEqual(expected);
      expect(screen.queryByRole("alert")).toBeNull();
    },
  );
});
