import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  createQueryWrapper,
  createTestQueryClient,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@/test";
import { enterDateTime } from "@/test/dateTimeField";
import { providerPlanSelection } from "../../../../../../packages/core/src/travel-plans/__fixtures__/providerPlan";

vi.mock("next-intl", async () =>
  (await import("@/test/intl")).mockNextIntl({ useLocale: () => "de" }),
);

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ flyTo: vi.fn() }),
  useMapOptional: () => null,
}));

const selectionCallbacks = vi.hoisted(() => ({
  select: undefined as
    | ((
        parent: import("@openmapx/mobility-core/transit").TripItinerary,
        candidate: import("@openmapx/mobility-core/transit").TripItinerary,
      ) => void)
    | undefined,
  refresh: undefined as
    | ((
        updated: import("@openmapx/mobility-core/transit").TripItinerary,
        changed: boolean,
        fallback: boolean,
      ) => void)
    | undefined,
}));
vi.mock("@/components/panels/directions/TransitDetailsView", async (original) => {
  const actual = await original<typeof import("./TransitDetailsView")>();
  return {
    TransitDetailsView: (props: Parameters<typeof actual.TransitDetailsView>[0]) => {
      selectionCallbacks.select = props.onSelectItinerary;
      return <actual.TransitDetailsView {...props} />;
    },
  };
});
const useDirectionsMock = vi.fn();
const useScheduledDirectionsMock = vi.fn();
const useTransitPlanMock = vi.fn();
const useTransitChainPlanMock = vi.fn();
const useEvDirectionsMock = vi.fn();
const useAutocompleteMock = vi.fn();
const transitCollection = vi.hoisted(() => ({
  journey: undefined as import("@openmapx/mobility-core/transit").VehicleJourney | undefined,
  alerts: [] as import("@openmapx/mobility-core/transit").ServiceAlert[],
}));
let capabilityServices: Record<string, { available: boolean }> = {};
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useDirections: (...a: unknown[]) => useDirectionsMock(...a),
    useScheduledDirections: (...a: unknown[]) => useScheduledDirectionsMock(...a),
    useTransitPlan: (...a: unknown[]) => useTransitPlanMock(...a),
    useTransitChainPlan: (...a: unknown[]) => useTransitChainPlanMock(...a),
    useEvDirections: (...a: unknown[]) => useEvDirectionsMock(...a),
    useAutocomplete: (...a: unknown[]) => useAutocompleteMock(...a),
    useRideProviders: () => ({
      data: {
        providers: [
          {
            id: "uber",
            name: "Uber",
            homepage: "https://www.uber.com/",
            capabilities: { deepLink: true, quote: false, booking: false, tracking: false },
            permitsComparison: false,
            availability: { available: true, coverageChecked: false, products: [] },
            handoffCarriesCoordinates: true,
            isDefault: true,
          },
        ],
        defaultProvider: "uber",
        comparison: { allowed: false, comparableProviderIds: [] },
      },
      isLoading: false,
    }),
    useRideQuotes: () => ({ results: [], expiresAt: null, refetch: vi.fn() }),
    useVehicleJourney: () => ({ data: transitCollection.journey }),
    useRouteAlerts: () => ({ data: transitCollection.alerts }),
    useCapabilities: () => ({ services: capabilityServices }),
    useOptimizeRoute: () => ({ mutate: vi.fn(), isPending: false }),
    useRouteInGermany: () => ({ bothInGermany: false }),
  };
});

// TransitItineraryCard's real mount needs ~8 module mocks (see its own spec);
// keep the card shallow while its Details action opens the real detail consumer.
vi.mock("./RouteStopSearch", () => ({
  RouteStopSearch: (props: { provider?: string; request: { mode: string }; units: string }) => (
    <div
      data-testid="route-stop-search"
      data-mode={props.request.mode}
      data-provider={props.provider}
    />
  ),
}));
vi.mock("@/components/panels/directions/TransitRouteView", () => ({
  TransitItineraryCard: ({
    itinerary,
    onDetails,
    onRefreshed,
  }: {
    itinerary: { duration: number };
    onDetails?: () => void;
    onRefreshed?: (
      updated: import("@openmapx/mobility-core/transit").TripItinerary,
      changed: boolean,
      fallback: boolean,
    ) => void;
  }) => {
    selectionCallbacks.refresh = onRefreshed;
    return (
      <div data-testid="transit-itinerary-card">
        {itinerary.duration}
        <button type="button" onClick={onDetails}>
          Open transit details
        </button>
      </div>
    );
  },
  LegBadge: () => <span />,
  LegRemarks: () => null,
  LiveStopTime: ({ time }: { time: { scheduledAt?: string; expectedAt?: string } }) => (
    <span>{time.expectedAt ?? time.scheduledAt}</span>
  ),
  TransitEmissionsBadge: () => null,
  TransitLiveBadge: () => null,
}));

import {
  ApiClientError,
  type DirectionsResult,
  directionsQueryKey,
  formatDuration,
  useDirectionsStore,
  useMapStore,
  useSettingsStore,
  useSidebarStore,
} from "@openmapx/core";
import { MobileSheetContext } from "@/components/panels/sheet/sheetState";
import { DirectionsPanelContent } from "./DirectionsPanelContent";

/** Last positional call arg of a mocked hook, typed for the fields under test.
 * A stand-in for `toHaveBeenLastCalledWith`/`toMatchObject` partial matching,
 * neither of which this repo's local `vitest.d.ts` type shim declares. */
function lastArg<T>(mockFn: { mock: { calls: unknown[][] } }): T {
  return mockFn.mock.calls.at(-1)?.[0] as T;
}

interface DirectionsCallArgs {
  waypoints: [number, number][];
  mode: string;
  lang: string;
  departAt?: string;
  arriveBy?: string;
}
interface TransitCallArgs {
  origin: [number, number] | null;
  destination: [number, number] | null;
}

beforeEach(() => {
  capabilityServices = {};
  transitCollection.journey = undefined;
  transitCollection.alerts = [];
  useDirectionsMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useScheduledDirectionsMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useTransitPlanMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useTransitChainPlanMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useEvDirectionsMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useAutocompleteMock.mockReset().mockReturnValue({ data: [] });
  act(() => {
    useDirectionsStore.getState().close();
    useDirectionsStore.getState().setMode("driving");
    useSidebarStore.setState({ activeSidebarId: null });
    useMapStore.setState({ userLocation: null });
    useSettingsStore.getState().setEvVehicleId(null);
  });
});

afterEach(() => vi.unstubAllGlobals());

function seedOriginDestination() {
  act(() => {
    useDirectionsStore.getState().setWaypoint(0, [13.3, 52.5], "Berlin");
    useDirectionsStore.getState().setWaypoint(1, [11.5, 48.1], "Munich");
  });
}

const renderPanel = () => render(<DirectionsPanelContent />, { wrapper: createQueryWrapper() });

describe("DirectionsPanelContent", () => {
  it.each([502, 503, 504])("shows unavailable routing for an HTTP %i road response", (status) => {
    seedOriginDestination();
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiClientError(status, null, null),
      refetch: vi.fn(),
    });

    renderPanel();
    screen.getByText("directions.routeServiceUnavailable");
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
    screen.getByRole("button", { name: "common.retry" });
  });

  it.each([400, 404, 429, 500, 501, 505])(
    "keeps HTTP %i road failures as generic request failures",
    (status) => {
      seedOriginDestination();
      useDirectionsMock.mockReturnValue({
        data: undefined,
        isLoading: false,
        isError: true,
        error: new ApiClientError(status, null, null),
        refetch: vi.fn(),
      });

      renderPanel();
      screen.getByText("directions.routeRequestFailed");
      expect(screen.queryByText("directions.routeServiceUnavailable")).toBeNull();
    },
  );

  it("keeps an unstructured network failure generic", () => {
    seedOriginDestination();
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new TypeError("Failed to fetch"),
      refetch: vi.fn(),
    });

    renderPanel();
    screen.getByText("directions.routeRequestFailed");
    expect(screen.queryByText("directions.routeServiceUnavailable")).toBeNull();
  });

  it.each([
    ["ride", useDirectionsMock, () => useDirectionsStore.getState().setMode("ride")],
    [
      "EV",
      useEvDirectionsMock,
      () => {
        useSettingsStore.getState().setEvVehicleId("test-vehicle");
        useDirectionsStore.getState().setEvMode(true);
      },
    ],
    ["transit", useTransitPlanMock, () => useDirectionsStore.getState().setMode("transit")],
    [
      "chained transit",
      useTransitChainPlanMock,
      () => {
        useDirectionsStore.getState().addWaypoint(0);
        useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
        useDirectionsStore.getState().setMode("transit");
      },
    ],
    [
      "scheduled",
      useScheduledDirectionsMock,
      () => {
        useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 });
      },
    ],
  ] as const)("shows an unavailable %s planning response", (_name, hook, configure) => {
    seedOriginDestination();
    act(configure);
    hook.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiClientError(503, null, null),
      refetch: vi.fn(),
    });

    renderPanel();
    screen.getByText("directions.routeServiceUnavailable");
    screen.getByRole("button", { name: "common.retry" });
  });

  it("requests a fresh location when opened and fills the origin", async () => {
    let succeed: ((position: GeolocationPosition) => void) | undefined;
    const getCurrentPosition = vi.fn((...args: unknown[]) => {
      succeed = args[0] as (position: GeolocationPosition) => void;
    });
    vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
    act(() => useDirectionsStore.getState().open());

    renderPanel();

    expect(getCurrentPosition).toHaveBeenCalled();
    expect(getCurrentPosition.mock.calls.at(-1)?.[2]).toEqual({ maximumAge: 0 });

    // The fix now arrives through the one-fix adapter, so it lands a microtask
    // after the callback rather than inside it.
    await act(async () => {
      succeed?.({
        coords: { longitude: 13.405, latitude: 52.52 },
        timestamp: Date.now(),
      } as GeolocationPosition);
    });

    expect(useDirectionsStore.getState().waypoints[0]).toMatchObject({
      coords: [13.405, 52.52],
      label: "directions.myLocation",
    });
    expect(useMapStore.getState().userLocation).toEqual([13.405, 52.52]);
  });

  it("mounts with empty waypoints: placeholders + empty-state prompt", () => {
    renderPanel();
    screen.getByPlaceholderText("directions.chooseOrigin");
    screen.getByPlaceholderText("directions.chooseDestination");
    // Placeholder text lives on the input's `placeholder` attribute, not as
    // rendered text — only the empty-state prompt (line 784) is found by text.
    screen.getByText("directions.chooseOrigin");
  });

  it("renders waypoints from store state and feeds them to the planning boundary", () => {
    seedOriginDestination();
    renderPanel();

    screen.getByDisplayValue("Berlin");
    screen.getByDisplayValue("Munich");
    const arg = lastArg<DirectionsCallArgs>(useDirectionsMock);
    expect(arg.waypoints).toEqual([
      [13.3, 52.5],
      [11.5, 48.1],
    ]);
    expect(arg.mode).toBe("driving");
    expect(arg.lang).toBe("de");
  });

  it("add stop: adds an empty waypoint (suppressing the re-plan) then fills it via autocomplete selection", async () => {
    seedOriginDestination();
    renderPanel();

    fireEvent.click(screen.getByText("directions.addStop"));
    expect(useDirectionsStore.getState().waypoints.length).toBe(3);
    // New stop is empty → the re-plan request is suppressed (gating contract).
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([]);

    useAutocompleteMock.mockReturnValue({
      data: [{ id: "x", label: "Leipzig", type: "poi", coordinates: [12.37, 51.34] }],
    });

    const middleInput = screen.getByPlaceholderText(/directions.addStop 1/);
    fireEvent.focus(middleInput);
    fireEvent.change(middleInput, { target: { value: "l" } });

    fireEvent.click(await screen.findByText("Leipzig"));

    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([
      [13.3, 52.5],
      [12.37, 51.34],
      [11.5, 48.1],
    ]);
  });

  it("credits displayed waypoint suggestions and removes the credit when selected", async () => {
    seedOriginDestination();
    const supplier = { sourceId: "waypoint", name: "Waypoint supplier" };
    useAutocompleteMock.mockReturnValue({
      data: [
        {
          id: "x",
          label: "Leipzig",
          type: "poi",
          coordinates: [12.37, 51.34],
          contributors: [supplier],
        },
      ],
    });
    renderPanel();
    fireEvent.click(screen.getByText("directions.addStop"));
    const input = screen.getByPlaceholderText(/directions.addStop 1/);
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Leipzig" } });
    expect(await screen.findByText("Waypoint supplier")).toBeVisible();
    fireEvent.click(screen.getByText("Leipzig"));
    await waitFor(() => expect(screen.queryByText("Waypoint supplier")).not.toBeInTheDocument());
  });

  it("remove stop: goes back to two waypoints and re-plans with the remaining pair", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
    });
    renderPanel();

    // 3 waypoints → every row (incl. origin/destination) shows a remove
    // button (WaypointRow: `canRemove = total > 2`). Removing the first row
    // (the origin, "Berlin") leaves the middle+destination pair.
    const removeButtons = screen.getAllByRole("button", { name: "directions.removeStop" });
    expect(removeButtons.length).toBe(3);
    fireEvent.click(removeButtons[0]);

    expect(useDirectionsStore.getState().waypoints.length).toBe(2);
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([
      [12.37, 51.34],
      [11.5, 48.1],
    ]);
  });

  it("reverse: swaps input values and re-plans with reversed waypoints; store-level reorder also flows through", () => {
    seedOriginDestination();
    const { container } = renderPanel();

    const reverseButton = container
      .querySelector('svg[data-testid="SwapVertIcon"]')
      ?.closest("button");
    expect(reverseButton).not.toBeNull();
    fireEvent.click(reverseButton as HTMLButtonElement);

    screen.getByDisplayValue("Munich");
    screen.getByDisplayValue("Berlin");
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([
      [11.5, 48.1],
      [13.3, 52.5],
    ]);

    act(() => {
      useDirectionsStore.getState().reorderWaypoints(0, 1);
    });
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([
      [13.3, 52.5],
      [11.5, 48.1],
    ]);
  });

  it("switching travel mode updates request params (walking then transit)", () => {
    seedOriginDestination();
    renderPanel();

    fireEvent.click(screen.getByLabelText("directions.walking"));
    expect(useDirectionsStore.getState().mode).toBe("walking");
    const walkingArg = lastArg<DirectionsCallArgs>(useDirectionsMock);
    expect(walkingArg.mode).toBe("walking");
    expect(walkingArg.waypoints).toEqual([
      [13.3, 52.5],
      [11.5, 48.1],
    ]);

    fireEvent.click(screen.getByLabelText("directions.transit"));
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([]);
    const transitArg = lastArg<TransitCallArgs>(useTransitPlanMock);
    expect(transitArg.origin).toEqual([13.3, 52.5]);
    expect(transitArg.destination).toEqual([11.5, 48.1]);
  });

  it("exposes one selected travel mode and changes it with keyboard selection", () => {
    seedOriginDestination();
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "directions.travelMode" });
    const driving = screen.getByRole("radio", { name: "directions.driving" });
    const walking = screen.getByRole("radio", { name: "directions.walking" });
    expect(group.contains(driving)).toBe(true);
    expect((driving as HTMLInputElement).checked).toBe(true);
    walking.focus();
    fireEvent.keyDown(walking, { key: "Enter" });
    expect(useDirectionsStore.getState().mode).toBe("walking");
    expect((walking as HTMLInputElement).checked).toBe(true);
  });

  it("keeps every travel mode in the full-width row with a wrapping fallback", () => {
    renderPanel();
    const group = screen.getByRole("radiogroup", { name: "directions.travelMode" });
    expect(group.querySelectorAll('input[type="radio"]')).toHaveLength(7);
    expect(getComputedStyle(group).flexWrap).toBe("wrap");
    expect(getComputedStyle(group).overflowX).not.toBe("auto");
    expect(
      group.parentElement?.contains(screen.getByRole("button", { name: "directions.close" })),
    ).toBe(true);
  });

  it("driving depart/arrive time feeds the request after the debounce", async () => {
    seedOriginDestination();
    renderPanel();

    fireEvent.click(screen.getByText("directions.departNow"));
    const departAtTab = screen.getByText("directions.departAt");
    fireEvent.click(departAtTab);

    await enterDateTime(
      screen.getByRole("group", { name: "directions.departAt" }),
      "2026-07-04T09:30",
    );

    await waitFor(() => {
      const arg = lastArg<DirectionsCallArgs>(useDirectionsMock);
      expect(arg.departAt).toBe("2026-07-04T09:30");
    });
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).arriveBy).toBe(undefined);

    const arriveByTab = screen.getByText("directions.arriveBy");
    fireEvent.click(arriveByTab);
    await enterDateTime(
      screen.getByRole("group", { name: "directions.arriveBy" }),
      "2026-07-04T18:00",
    );

    await waitFor(() => {
      const arg = lastArg<DirectionsCallArgs>(useDirectionsMock);
      expect(arg.arriveBy).toBe("2026-07-04T18:00");
    });
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).departAt).toBe(undefined);
  });

  it("transit mode delegates to the shallow-stubbed transit view for each itinerary", async () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().setMode("transit");
    });
    const itineraries = [
      {
        duration: 3600,
        startTime: "2026-07-04T09:00:00Z",
        endTime: "2026-07-04T10:00:00Z",
        transfers: 1,
        walkDistance: 250,
        legs: [],
      },
      {
        duration: 5400,
        startTime: "2026-07-04T09:10:00Z",
        endTime: "2026-07-04T10:40:00Z",
        transfers: 0,
        walkDistance: 100,
        legs: [],
      },
    ];
    useTransitPlanMock.mockReturnValue({
      data: { itineraries, provider: "ms" },
      isLoading: false,
      isError: false,
    });

    renderPanel();

    expect((await screen.findAllByTestId("transit-itinerary-card")).length).toBe(2);
    expect(useDirectionsStore.getState().transitItineraries.length).toBe(2);
    // Berlin -> Munich is same-zone, so the destination-zone caption must not
    // render. Note this does *not* pin the (lat, lng) argument order on its
    // own: swapping it on this exact pair resolves to Asia/Aden vs
    // Africa/Mogadishu, which happen to share the same GMT+03:00 offset, so
    // the offset-diff gate would still suppress the caption and this
    // assertion would still pass either way. The Berlin -> Tokyo spec below
    // is what actually pins the order.
    expect(screen.queryByText("directions.arrivalInDestinationTime")).toBeNull();
  });

  it("shows the destination-zone caption when the trip actually crosses zones", async () => {
    act(() => {
      useDirectionsStore.getState().setWaypoint(0, [13.405, 52.52], "Berlin");
      useDirectionsStore.getState().setWaypoint(1, [139.69, 35.68], "Tokyo");
      useDirectionsStore.getState().setMode("transit");
    });
    useTransitPlanMock.mockReturnValue({
      data: {
        itineraries: [
          {
            duration: 3600,
            startTime: "2026-07-04T09:00:00Z",
            endTime: "2026-07-04T10:00:00Z",
            transfers: 0,
            walkDistance: 0,
            legs: [],
          },
        ],
        provider: "ms",
      },
      isLoading: false,
      isError: false,
    });

    renderPanel();

    await screen.findAllByTestId("transit-itinerary-card");
    // This is what actually pins the (lat, lng) argument order passed to the
    // real timeZoneAt (mocked here via importOriginal): waypoint coords are
    // stored as [lng, lat] and the assertion below requires the destination
    // zone to have resolved. Swapping the order for Tokyo's [139.69, 35.68]
    // calls timeZoneAt(139.69, 35.68) — 139.69 isn't a valid latitude, so
    // tz-lookup throws, timeZoneAt degrades to null, destinationTimeZone
    // stays null, and this assertion fails.
    expect(screen.getByText("directions.arrivalInDestinationTime")).toBeInTheDocument();
  });

  it("transit request failure offers Retry for the active plan", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().setMode("transit");
    });
    const refetch = vi.fn();
    useTransitPlanMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    const view = renderPanel();
    screen.getByText("directions.routeRequestFailed");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
    useTransitPlanMock.mockReturnValue({
      data: { itineraries: [], provider: "transit-motis-local" },
      isLoading: false,
      isError: false,
    });
    view.rerender(<DirectionsPanelContent />);
    screen.getByText("directions.noRoutesFound");
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
  });

  it("road request failure retries without changing the endpoints", () => {
    seedOriginDestination();
    const refetch = vi.fn();
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    const view = renderPanel();
    screen.getByText("directions.routeRequestFailed");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(useDirectionsStore.getState().waypoints.map((wp) => wp.label)).toEqual([
      "Berlin",
      "Munich",
    ]);
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([
      [13.3, 52.5],
      [11.5, 48.1],
    ]);
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
    useDirectionsMock.mockReturnValue({
      data: {
        waypoints: [
          [13.3, 52.5],
          [11.5, 48.1],
        ],
        routes: [{ mode: "driving", duration: 600, distance: 5000, legs: [] }],
        activeRouteIndex: 0,
      },
      isLoading: false,
      isError: false,
    });
    view.rerender(<DirectionsPanelContent />);
    screen.getByRole("radiogroup", { name: "directions.routes" });
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
  });

  it("successful empty road response offers input alternatives and supported modes", () => {
    seedOriginDestination();
    capabilityServices = { "routing-valhalla": { available: true } };
    useDirectionsMock.mockReturnValue({
      data: {
        waypoints: [
          [13.3, 52.5],
          [11.5, 48.1],
        ],
        routes: [],
        activeRouteIndex: 0,
      },
      isLoading: false,
      isError: false,
    });

    renderPanel();
    screen.getByText("directions.noRoutesFound");
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "directions.changeDestination" }));
    expect(document.activeElement).toBe(screen.getByDisplayValue("Munich"));
    expect(useDirectionsStore.getState().waypoints[1].coords).toEqual([11.5, 48.1]);
    const modeButtons = screen.getAllByRole("button", { name: "directions.tryMode" });
    expect(modeButtons).toHaveLength(3);
    fireEvent.click(modeButtons[0]);
    expect(useDirectionsStore.getState().mode).toBe("walking");
  });

  it("does not advertise unverified or unavailable mode shortcuts", () => {
    seedOriginDestination();
    capabilityServices = {
      "routing-osrm": { available: true },
      "routing-valhalla": { available: false },
    };
    useDirectionsMock.mockReturnValue({
      data: {
        waypoints: [
          [13.3, 52.5],
          [11.5, 48.1],
        ],
        routes: [],
        activeRouteIndex: 0,
      },
      isLoading: false,
      isError: false,
    });

    renderPanel();
    expect(screen.queryByRole("button", { name: "directions.tryMode" })).toBeNull();
    screen.getByRole("button", { name: "directions.changeOrigin" });
    screen.getByRole("button", { name: "directions.changeDestination" });
  });

  it("clearing a waypoint suppresses an old request failure", () => {
    seedOriginDestination();
    useDirectionsMock.mockImplementation((arg: unknown) => ({
      data: undefined,
      isLoading: false,
      isError: (arg as DirectionsCallArgs).waypoints.length > 0,
      refetch: vi.fn(),
    }));
    renderPanel();
    screen.getByText("directions.routeRequestFailed");
    fireEvent.change(screen.getByDisplayValue("Munich"), { target: { value: "" } });
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("keeps an active road request pending without reporting no route", () => {
    seedOriginDestination();
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
      isFetching: false,
      isError: false,
    });

    renderPanel();
    screen.getByRole("progressbar");
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
  });

  it("ride mode keeps its provider handoff and retries a failed driving route", async () => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setMode("ride"));
    const refetch = vi.fn();
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    renderPanel();
    screen.getByText("directions.routeRequestFailed");
    screen.getByText("directions.rideDisclaimer");
    await screen.findByRole("button", { name: "directions.rideOpenIn" });
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(useDirectionsStore.getState().mode).toBe("ride");
    expect(useDirectionsStore.getState().waypoints.map((wp) => wp.label)).toEqual([
      "Berlin",
      "Munich",
    ]);
  });

  it("ride mode keeps its provider handoff alongside a successful empty route", async () => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setMode("ride"));
    useDirectionsMock.mockReturnValue({
      data: {
        waypoints: [
          [13.3, 52.5],
          [11.5, 48.1],
        ],
        routes: [],
        activeRouteIndex: 0,
      },
      isLoading: false,
      isError: false,
    });

    renderPanel();
    screen.getByText("directions.noRoutesFound");
    screen.getByText("directions.rideDisclaimer");
    await screen.findByRole("button", { name: "directions.rideOpenIn" });
    screen.getByRole("button", { name: "directions.changeOrigin" });
    screen.getByRole("button", { name: "directions.changeDestination" });
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("ride mode shows a pending route without hiding its provider handoff", () => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setMode("ride"));
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      isPending: true,
      isFetching: false,
    });

    renderPanel();
    screen.getByRole("progressbar");
    screen.getByText("directions.rideDisclaimer");
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
  });

  it("EV mode hides the add-stop control and drops any existing intermediate waypoint", () => {
    // ev-plan.ts's re-route only splices charge stops between the first and
    // last waypoint (see the doc comment above its `wps` construction) — an
    // intermediate waypoint added before switching to EV mode would silently
    // stop matching what the map draws, so entering EV mode must both trim
    // any existing via and hide the control that would let the user add one.
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
    });
    renderPanel();

    expect(useDirectionsStore.getState().waypoints.length).toBe(3);
    screen.getByText("directions.addStop");

    fireEvent.click(screen.getByRole("button", { name: "directions.evMode" }));

    expect(useDirectionsStore.getState().isEvMode).toBe(true);
    expect(useDirectionsStore.getState().waypoints.map((w) => w.label)).toEqual([
      "Berlin",
      "Munich",
    ]);
    expect(screen.queryByText("directions.addStop")).toBeNull();
  });

  describe("mobile sheet interactions", () => {
    // Wraps the panel with a peek-state MobileSheetContext and a spy snapTo,
    // the way the real MobileBottomSheet does once collapsed.
    function renderAtPeek() {
      const snapTo = vi.fn();
      const Wrapper = createQueryWrapper();
      const { container } = render(
        <Wrapper>
          <MobileSheetContext.Provider
            value={{ detent: "peek", inSheet: true, isExpanded: false, snapTo }}
          >
            <DirectionsPanelContent />
          </MobileSheetContext.Provider>
        </Wrapper>,
      );
      return { snapTo, container };
    }

    it("tapping the collapsed panel's background expands the sheet to mid", () => {
      const { snapTo, container } = renderAtPeek();
      fireEvent.click(container.firstElementChild as Element);
      expect(snapTo).toHaveBeenCalledWith("mid");
    });

    // A control already does something; expanding as the event bubbles would
    // undo it — selecting a route collapses the sheet, and an unguarded handler
    // would immediately re-expand it.
    it("tapping a control inside the collapsed panel does not expand the sheet", () => {
      const { snapTo } = renderAtPeek();
      fireEvent.click(screen.getByLabelText("directions.menu"));
      expect(snapTo).not.toHaveBeenCalledWith("mid");
    });

    it("focusing a waypoint field expands the sheet to full", () => {
      const { snapTo } = renderAtPeek();
      fireEvent.focus(screen.getByPlaceholderText("directions.chooseOrigin"));
      expect(snapTo).toHaveBeenCalledWith("full");
    });

    it("selecting a route collapses the sheet to peek", () => {
      seedOriginDestination();
      useDirectionsMock.mockReturnValue({
        data: {
          provider: "osrm",
          routes: [
            { mode: "driving", duration: 600, distance: 5000, legs: [] },
            { mode: "driving", duration: 700, distance: 5200, legs: [] },
          ],
        },
        isLoading: false,
        isError: false,
      });
      const { snapTo } = renderAtPeek();

      fireEvent.click(screen.getAllByText("directions.bestRoute")[1]);
      expect(snapTo).toHaveBeenCalledWith("peek");
    });
  });
});

interface ScheduleCallArgs {
  waypoints: [number, number][];
  schedules: (Record<string, unknown> | null)[];
  departAt?: string;
  arriveBy?: string;
}

describe("scheduled trips", () => {
  it("retries the scheduled request and ignores the disabled plain query's error", () => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 }));
    const scheduledRefetch = vi.fn();
    const plainRefetch = vi.fn();
    useScheduledDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: scheduledRefetch,
    });
    useDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: plainRefetch,
    });

    renderPanel();
    screen.getByText("directions.routeRequestFailed");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(scheduledRefetch).toHaveBeenCalledTimes(1);
    expect(plainRefetch).not.toHaveBeenCalled();
    expect(useDirectionsStore.getState().waypoints[1]).toMatchObject({
      coords: [11.5, 48.1],
      label: "Munich",
      schedule: { dwellSeconds: 1800 },
    });
  });

  it("treats a successful empty scheduled response as no route", () => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 }));
    useScheduledDirectionsMock.mockReturnValue({
      data: {
        waypoints: [
          [13.3, 52.5],
          [11.5, 48.1],
        ],
        routes: [],
        activeRouteIndex: 0,
      },
      isLoading: false,
      isError: false,
    });

    renderPanel();
    screen.getByText("directions.noRoutesFound");
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("keeps using the plain directions query when nothing is constrained", () => {
    seedOriginDestination();
    renderPanel();

    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([
      [13.3, 52.5],
      [11.5, 48.1],
    ]);
    expect(useScheduledDirectionsMock).toHaveBeenCalledWith(null);
  });

  it("switches to the scheduled query as soon as a waypoint carries a schedule", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
      useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 });
    });
    renderPanel();

    const arg = lastArg<ScheduleCallArgs>(useScheduledDirectionsMock);
    expect(arg.waypoints).toEqual([
      [13.3, 52.5],
      [12.37, 51.34],
      [11.5, 48.1],
    ]);
    expect(arg.schedules).toEqual([null, { dwellSeconds: 1800 }, null]);
    // Exactly one query is live, so the two never split the cache.
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).waypoints).toEqual([]);
  });

  it("reads the trip time from the store rather than local state", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().setTimeMode("depart");
      useDirectionsStore.getState().setTripTime(new Date(2026, 8, 1, 9, 30));
    });
    renderPanel();

    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).departAt).toBe("2026-09-01T09:30");
  });

  it("carries the trip time into the scheduled request as departAt", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().setTimeMode("depart");
      useDirectionsStore.getState().setTripTime(new Date(2026, 8, 1, 9, 30));
      useDirectionsStore.getState().setWaypointSchedule(1, { arriveBy: "2026-09-01T14:00" });
    });
    renderPanel();

    expect(lastArg<ScheduleCallArgs>(useScheduledDirectionsMock).departAt).toBe("2026-09-01T09:30");
  });

  it("disables Optimize and explains why while a window constraint is set", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
      useDirectionsStore.getState().setWaypointSchedule(1, { fixedAt: "2026-09-01T14:00" });
    });
    renderPanel();

    const optimize = screen.getByRole("button", { name: /directions.optimizeStopOrder/ });
    expect(optimize.hasAttribute("disabled")).toBe(true);
    expect(optimize.getAttribute("title")).toBe("directions.scheduleOptimizeBlocked");
  });

  it("leaves Optimize enabled for a dwell-only trip", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
      useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 });
    });
    renderPanel();

    const optimize = screen.getByRole("button", { name: /directions.optimizeStopOrder/ });
    expect(optimize.hasAttribute("disabled")).toBe(false);
  });
});

describe("EV and chained transit recovery", () => {
  it("keeps an active EV request pending without reporting no route", () => {
    seedOriginDestination();
    act(() => {
      useSettingsStore.getState().setEvVehicleId("test-vehicle");
      useDirectionsStore.getState().setEvMode(true);
    });
    useEvDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
      isFetching: false,
      isError: false,
    });

    renderPanel();
    screen.getByRole("progressbar");
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
  });

  it("keeps an active chained transit request pending without reporting no route", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
      useDirectionsStore.getState().setMode("transit");
    });
    useTransitChainPlanMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isPending: true,
      isFetching: false,
      isError: false,
    });

    renderPanel();
    screen.getByRole("progressbar");
    expect(screen.queryByText("directions.noRoutesFound")).toBeNull();
    expect(screen.queryByText("directions.routeRequestFailed")).toBeNull();
  });

  it("retries the active EV request without changing vehicle or endpoints", () => {
    seedOriginDestination();
    act(() => {
      useSettingsStore.getState().setEvVehicleId("test-vehicle");
      useDirectionsStore.getState().setEvMode(true);
    });
    const refetch = vi.fn();
    useEvDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch,
    });

    const view = renderPanel();
    screen.getByText("directions.routeRequestFailed");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(refetch).toHaveBeenCalledTimes(1);
    expect(useSettingsStore.getState().evVehicleId).toBe("test-vehicle");
    expect(useDirectionsStore.getState().waypoints.map((wp) => wp.label)).toEqual([
      "Berlin",
      "Munich",
    ]);
    useEvDirectionsMock.mockReturnValue({
      data: {
        waypoints: [
          [13.3, 52.5],
          [11.5, 48.1],
        ],
        routes: [],
        activeRouteIndex: 0,
        stops: [],
        totals: { driveSeconds: 0, chargeSeconds: 0, energyKwh: 0 },
        warnings: [],
      },
      isLoading: false,
      isError: false,
    });
    view.rerender(<DirectionsPanelContent />);
    screen.getByText("directions.noRoutesFound");
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });

  it("shows chained transit failure and retries only that request", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().addWaypoint(0);
      useDirectionsStore.getState().setWaypoint(1, [12.37, 51.34], "Leipzig");
      useDirectionsStore.getState().setMode("transit");
    });
    const chainRefetch = vi.fn();
    const planRefetch = vi.fn();
    useTransitChainPlanMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: chainRefetch,
    });
    useTransitPlanMock.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      refetch: planRefetch,
    });

    const view = renderPanel();
    screen.getByText("directions.routeRequestFailed");
    fireEvent.click(screen.getByRole("button", { name: "common.retry" }));
    expect(chainRefetch).toHaveBeenCalledTimes(1);
    expect(planRefetch).not.toHaveBeenCalled();
    expect(useDirectionsStore.getState().waypoints.map((wp) => wp.label)).toEqual([
      "Berlin",
      "Leipzig",
      "Munich",
    ]);
    useTransitChainPlanMock.mockReturnValue({
      data: {
        segments: [],
        schedule: {
          stops: [],
          legs: [],
          departure: "2026-09-01T09:00:00+00:00",
          arrival: "2026-09-01T09:00:00+00:00",
          totalTravelSeconds: 0,
          totalDwellSeconds: 0,
          totalWaitSeconds: 0,
          multiDay: false,
          violations: [],
        },
        fidelity: "exact",
        warnings: [{ kind: "no-connection", segmentIndex: 0 }],
      },
      isLoading: false,
      isError: false,
    });
    view.rerender(<DirectionsPanelContent />);
    screen.getByText("directions.noRoutesFound");
    screen.getByText("directions.chainNoConnection");
    expect(screen.queryByRole("button", { name: "common.retry" })).toBeNull();
  });
});

it("credits scheduled cards, the ordinary mode-button duration and selected details", () => {
  seedOriginDestination();
  act(() => useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 }));
  const route = (name: string) => ({
    mode: "driving",
    duration: 600,
    distance: 5000,
    legs: [],
    steps: [],
    geometry: [
      [13.3, 52.5],
      [11.5, 48.1],
    ],
    contributors: [{ sourceId: name, name }],
  });
  useDirectionsMock.mockReturnValue({
    data: { routes: [route("Retained ordinary source")] },
    isLoading: false,
    isError: false,
  });
  useScheduledDirectionsMock.mockReturnValue({
    data: {
      routes: [route("Scheduled first source"), route("Scheduled alternate source")],
      schedule: {
        stops: [],
        legs: [],
        departure: "2026-09-01T09:00:00Z",
        arrival: "2026-09-01T10:00:00Z",
        totalTravelSeconds: 600,
        totalDwellSeconds: 1800,
        totalWaitSeconds: 0,
        multiDay: false,
        violations: [],
      },
      fidelity: "exact",
      warnings: [],
    },
    isLoading: false,
    isError: false,
  });
  renderPanel();
  expect(screen.getByText("Scheduled first source")).toBeTruthy();
  expect(screen.getByText("Scheduled alternate source")).toBeTruthy();
  const footer = screen.getByRole("contentinfo", { name: "Data sources" });
  const modes = screen.getByRole("radiogroup", { name: "directions.travelMode" });
  expect(modes.compareDocumentPosition(footer) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "footer.attributions" })).toHaveLength(1);
  // The ordinary duration remains painted on the active mode button.
  expect(screen.getByText("Retained ordinary source")).toBeTruthy();
  fireEvent.click(screen.getAllByText("common.details")[1]);
  expect(screen.getByText("Scheduled alternate source")).toBeTruthy();
  expect(screen.queryByText("Scheduled first source")).toBeNull();
  expect(screen.queryByText("Retained ordinary source")).toBeNull();
});

it("projects multi-stop leg metrics from indexed fields without reviving canonical empty children", () => {
  seedOriginDestination();
  act(() => {
    useDirectionsStore.getState().addWaypoint(0);
    useDirectionsStore.getState().setWaypoint(1, [12, 50], "Via");
  });
  const visible = { sourceId: "metrics", name: "Visible leg metrics" };
  const hidden = { sourceId: "hidden", name: "Hidden leg container" };
  useDirectionsMock.mockReturnValue({
    data: {
      routes: [
        {
          mode: "driving",
          duration: 600,
          distance: 5000,
          geometry: [
            [13.3, 52.5],
            [12, 50],
            [11.5, 48.1],
          ],
          steps: [],
          contributors: [],
          fieldContributors: {
            legs: [hidden],
            "legs.0.duration": [visible],
            "legs.0.distance": [],
            "legs.1.duration": [hidden],
          },
          legs: [
            { duration: 300, distance: 2500, geometry: [], steps: [] },
            { duration: 300, distance: 2500, geometry: [], steps: [], contributors: [] },
          ],
        },
      ],
    },
    isLoading: false,
    isError: false,
  });
  renderPanel();
  expect(screen.getByText("Visible leg metrics")).toBeTruthy();
  expect(screen.queryByText("Hidden leg container")).toBeNull();
});

it("credits the exact duration fields on inactive cached mode buttons", () => {
  seedOriginDestination();
  const queryClient = createTestQueryClient();
  const duration = { sourceId: "engine", name: "Captured walking duration" };
  const hidden = { sourceId: "engine", name: "Hidden walking geometry" };
  queryClient.setQueryData(
    directionsQueryKey({
      waypoints: [
        [13.3, 52.5],
        [11.5, 48.1],
      ],
      mode: "walking",
      avoidHighways: useDirectionsStore.getState().avoidHighways,
      avoidTolls: useDirectionsStore.getState().avoidTolls,
      avoidFerries: useDirectionsStore.getState().avoidFerries,
      avoidClosures: useSettingsStore.getState().avoidIncidents,
      units: useSettingsStore.getState().units,
      lang: "de",
    }),
    {
      routes: [
        {
          mode: "walking",
          duration: 600,
          distance: 5000,
          geometry: [],
          legs: [],
          steps: [],
          contributors: [hidden],
          fieldContributors: { duration: [duration], geometry: [hidden] },
        },
      ],
      waypoints: [],
      activeRouteIndex: 0,
      provider: "historical-engine",
    } satisfies DirectionsResult,
  );
  render(<DirectionsPanelContent />, { wrapper: createQueryWrapper(queryClient) });
  expect(screen.getByText(formatDuration(600))).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "footer.attributions" }));
  expect(screen.getByRole("dialog")).toHaveTextContent("Captured walking duration");
  expect(screen.queryByText("Hidden walking geometry")).toBeNull();
});

it("keeps cached empty duration receipts authoritative and hides spinner-only duration credits", () => {
  seedOriginDestination();
  const queryClient = createTestQueryClient();
  const hidden = { sourceId: "engine", name: "Hidden duration owner" };
  useDirectionsMock.mockReturnValue({
    data: { routes: [{ duration: 600, contributors: [hidden] }] },
    isLoading: true,
    isError: false,
  });
  queryClient.setQueryData(
    directionsQueryKey({
      waypoints: [
        [13.3, 52.5],
        [11.5, 48.1],
      ],
      mode: "cycling",
      avoidHighways: useDirectionsStore.getState().avoidHighways,
      avoidTolls: useDirectionsStore.getState().avoidTolls,
      avoidFerries: useDirectionsStore.getState().avoidFerries,
      avoidClosures: useSettingsStore.getState().avoidIncidents,
      units: useSettingsStore.getState().units,
      lang: "de",
    }),
    {
      routes: [
        {
          mode: "cycling",
          duration: 1200,
          distance: 5000,
          geometry: [],
          legs: [],
          steps: [],
          contributors: [hidden],
          fieldContributors: { duration: [] },
        },
      ],
      waypoints: [],
      activeRouteIndex: 0,
      provider: "historical-engine",
    } satisfies DirectionsResult,
  );
  render(<DirectionsPanelContent />, { wrapper: createQueryWrapper(queryClient) });
  expect(screen.getByText(formatDuration(1200))).toBeTruthy();
  expect(screen.queryByText(formatDuration(600))).toBeNull();
  expect(screen.queryByText("Hidden duration owner")).toBeNull();
  expect(screen.queryByRole("button", { name: "footer.attributions" })).toBeNull();
});

it("collects transit details, fetched stops and alerts into one mounted credit footer", () => {
  seedOriginDestination();
  act(() => useDirectionsStore.getState().setMode("transit"));
  const supplier = { sourceId: "transit", name: "Transit plan supplier" };
  const stopSupplier = { sourceId: "stops", name: "Fetched stop supplier" };
  const alertSupplier = { sourceId: "alerts", name: "Fetched alert supplier" };
  const itinerary = {
    duration: 3600,
    startTime: "2026-10-16T08:00:00Z",
    endTime: "2026-10-16T09:00:00Z",
    transfers: 0,
    walkDistance: 0,
    contributors: [supplier],
    legs: [
      {
        mode: "rail",
        startTime: "2026-10-16T08:00:00Z",
        endTime: "2026-10-16T09:00:00Z",
        from: { name: "From", lat: 50, lng: 8, stopId: "from" },
        to: { name: "To", lat: 51, lng: 9, stopId: "to" },
        route: { shortName: "ICE", longName: "Express", color: "DF2027" },
        tripId: "trip",
        routeId: "route",
        _intermediateStopCount: 1,
        contributors: [supplier],
      },
    ],
  };
  useTransitPlanMock.mockReturnValue({
    data: { provider: "captured", itineraries: [itinerary] },
    isLoading: false,
    isError: false,
  });
  const view = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Open transit details" }));
  expect(screen.getAllByText("Transit plan supplier")).toHaveLength(1);
  transitCollection.journey = {
    stops: [
      { stopId: "from", name: "From", contributors: [supplier] },
      { stopId: "middle", name: "Middle", contributors: [stopSupplier] },
      { stopId: "to", name: "To", contributors: [supplier] },
    ],
  } as never;
  transitCollection.alerts = [
    { id: "alert", severity: "warning", title: "Disruption", contributors: [alertSupplier] },
  ] as never;
  view.rerender(<DirectionsPanelContent />);
  expect(screen.getAllByText("Transit plan supplier")).toHaveLength(1);
  expect(screen.getByText("Fetched stop supplier")).toBeInTheDocument();
  expect(screen.getByText("Fetched alert supplier")).toBeInTheDocument();
  expect(screen.getAllByRole("button", { name: "footer.attributions" })).toHaveLength(1);
  transitCollection.journey = undefined;
  transitCollection.alerts = [];
  view.rerender(<DirectionsPanelContent />);
  expect(screen.queryByText("Fetched stop supplier")).not.toBeInTheDocument();
  expect(screen.queryByText("Fetched alert supplier")).not.toBeInTheDocument();
  expect(screen.getAllByText("Transit plan supplier")).toHaveLength(1);
});

describe("stops along the route", () => {
  const geometry: [number, number][] = [
    [13.3, 52.5],
    [12.4, 50.3],
    [11.5, 48.1],
  ];
  const routesResult = (mode: string) => ({
    data: {
      provider: "valhalla",
      routes: [{ mode, duration: 600, distance: 5000, legs: [], geometry }],
      activeRouteIndex: 0,
    },
    isLoading: false,
    isError: false,
  });

  it.each(["driving", "motorcycle"] as const)("is offered under %s routes before Start", (mode) => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setMode(mode));
    useDirectionsMock.mockReturnValue(routesResult(mode));
    renderPanel();
    const section = screen.getByTestId("route-stop-search");
    expect(section).toHaveAttribute("data-mode", mode);
    expect(section).toHaveAttribute("data-provider", "valhalla");
    const routes = screen.getByRole("radiogroup", { name: "directions.routes" });
    expect(routes.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("stays available after a stop was added, so a second stop can be found", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().insertWaypoint(1, [12.4, 50.3], "Aral");
    });
    useDirectionsMock.mockReturnValue({
      ...routesResult("driving"),
      data: {
        provider: "valhalla",
        routes: [
          {
            mode: "driving",
            duration: 600,
            distance: 5000,
            geometry,
            legs: [
              { duration: 300, distance: 2500 },
              { duration: 300, distance: 2500 },
            ],
          },
        ],
      },
    });
    renderPanel();
    expect(screen.getByTestId("route-stop-search")).toHaveAttribute("data-mode", "driving");
  });

  it.each(["walking", "cycling", "transit"] as const)("is not offered for %s", (mode) => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setMode(mode));
    useDirectionsMock.mockReturnValue(routesResult(mode));
    renderPanel();
    expect(screen.queryByTestId("route-stop-search")).toBeNull();
  });

  it("is not offered in EV mode or for scheduled trips", () => {
    seedOriginDestination();
    useDirectionsMock.mockReturnValue(routesResult("driving"));
    useScheduledDirectionsMock.mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
    });
    act(() => useDirectionsStore.getState().setWaypointSchedule(1, { dwellSeconds: 1800 }));
    const view = renderPanel();
    expect(screen.queryByTestId("route-stop-search")).toBeNull();
    act(() => {
      useDirectionsStore.getState().setWaypointSchedule(1, null);
      useDirectionsStore.getState().setEvMode(true);
    });
    view.rerender(<DirectionsPanelContent />);
    expect(screen.queryByTestId("route-stop-search")).toBeNull();
  });

  it("is not offered for a route without drawable geometry", () => {
    seedOriginDestination();
    useDirectionsMock.mockReturnValue({
      ...routesResult("driving"),
      data: { routes: [{ mode: "driving", duration: 600, distance: 5000, legs: [] }] },
    });
    renderPanel();
    expect(screen.queryByTestId("route-stop-search")).toBeNull();
  });
});

function reviewTransitFixture(): import("@openmapx/mobility-core/transit").TripItinerary {
  const leg = {
    mode: "rail" as const,
    from: { name: "Aachen", stopId: "a", lat: 50.7678, lng: 6.0914 },
    to: { name: "Köln", stopId: "b", lat: 50.943, lng: 6.9587 },
    startTime: "2026-11-06T20:44:00Z",
    endTime: "2026-11-06T21:22:00Z",
    route: { shortName: "EST", longName: "" },
    tripId: "mo:est",
    geometry: { type: "LineString" as const, coordinates: [] },
  };
  const replacement = {
    ...leg,
    startTime: "2026-11-06T20:51:00Z",
    endTime: "2026-11-06T21:44:00Z",
    route: { shortName: "RE1", longName: "" },
    tripId: "mo:re1",
  };
  return {
    id: "parent",
    source: "mo",
    instance: "mo",
    datasetEpoch: "epoch",
    regionalOnly: true,
    startTime: leg.startTime,
    endTime: leg.endTime,
    duration: 2280,
    transfers: 0,
    walkDistance: 0,
    legs: [
      {
        ...leg,
        alternatives: [
          {
            routeShortName: "RE1",
            startTime: replacement.startTime,
            endTime: replacement.endTime,
            replaces: { fromLegIndex: 0, toLegIndex: 0 },
            legs: [replacement],
          },
        ],
      },
    ],
  };
}
function publishReviewTransit(items: import("@openmapx/mobility-core/transit").TripItinerary[]) {
  useTransitPlanMock.mockReturnValue({
    data: { provider: "mo", itineraries: items },
    isLoading: false,
    isError: false,
  });
}
it("keeps real details and active selection across result object replacement and preserves an inserted alternative", async () => {
  seedOriginDestination();
  act(() => useDirectionsStore.getState().setMode("transit"));
  const parent = reviewTransitFixture();
  publishReviewTransit([parent]);
  const view = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Open transit details" }));
  publishReviewTransit([{ ...parent }]);
  view.rerender(<DirectionsPanelContent />);
  await waitFor(() => expect(screen.queryByTestId("transit-itinerary-card")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /RE1 ·/ }));
  const selected = useDirectionsStore.getState().transitItineraries[1];
  expect(selected.legs[0].tripId).toBe("mo:re1");
  expect(useDirectionsStore.getState().activeItineraryIndex).toBe(1);
  publishReviewTransit([{ ...parent }]);
  view.rerender(<DirectionsPanelContent />);
  await waitFor(() => expect(screen.queryByTestId("transit-itinerary-card")).toBeNull());
  expect(
    useDirectionsStore.getState().transitItineraries[
      useDirectionsStore.getState().activeItineraryIndex
    ],
  ).toBe(selected);
  expect(screen.getAllByText("RE1").length).toBeGreaterThan(0);
  expect(useDirectionsStore.getState().transitItineraries).toHaveLength(2);
});
it("ignores an old details callback after the user changes the search", () => {
  seedOriginDestination();
  act(() => useDirectionsStore.getState().setMode("transit"));
  const parent = reviewTransitFixture();
  publishReviewTransit([parent]);
  renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "Open transit details" }));
  const stale = selectionCallbacks.select;
  act(() => useDirectionsStore.getState().setMaxTransfers(0));
  act(() =>
    stale?.(parent, {
      ...parent,
      id: undefined,
      legs: [{ ...parent.legs[0], tripId: "mo:another" }],
    }),
  );
  expect(useDirectionsStore.getState().transitItineraries).toEqual([parent]);
  expect(useDirectionsStore.getState().activeItineraryIndex).toBe(0);
  expect(screen.queryAllByTestId("transit-itinerary-card")).toHaveLength(1);
});
it.each(["same", "changed", "fallback"])(
  "handles the regional label after a %s refresh in the panel",
  (kind) => {
    seedOriginDestination();
    act(() => useDirectionsStore.getState().setMode("transit"));
    const parent = reviewTransitFixture();
    publishReviewTransit([parent]);
    renderPanel();
    const updated = {
      ...parent,
      regionalOnly: undefined,
      legs: parent.legs.map((l) => ({ ...l, tripId: kind === "changed" ? "mo:new" : l.tripId })),
    };
    act(() => selectionCallbacks.refresh?.(updated, false, kind === "fallback"));
    expect(useDirectionsStore.getState().transitItineraries[0].regionalOnly).toBe(
      kind === "same" ? true : undefined,
    );
  },
);

it("opens provided provider details and keeps their origin when an earlier auto-location resolves", async () => {
  let giveFix: PositionCallback = () => {};
  const getCurrentPosition = vi.fn((...args: unknown[]) => {
    giveFix = args[0] as PositionCallback;
  });
  vi.stubGlobal("navigator", { geolocation: { getCurrentPosition } });
  const client = createTestQueryClient();
  client.setQueryData(["transit-planning-capabilities"], {
    providers: [
      {
        id: "transit-motis-local",
        metadata: {
          source: "transit-motis-local",
          instance: "ms",
          datasetEpoch: "E",
          rentalFormFactors: [],
        },
      },
    ],
  });
  useDirectionsStore.getState().open();
  render(<DirectionsPanelContent />, { wrapper: createQueryWrapper(client) });
  await waitFor(() => expect(getCurrentPosition).toHaveBeenCalled());
  const selection = providerPlanSelection({
    bikeHillPreference: useDirectionsStore.getState().bikeHillPreference,
  });
  act(() => {
    useTransitPlanMock.mockReturnValue({
      data: selection.plan.data,
      isLoading: false,
      isError: false,
    });
    useDirectionsStore.getState().openTransitSelection(selection);
  });
  await act(async () =>
    giveFix({
      coords: { longitude: 13, latitude: 52, accuracy: 5 },
      timestamp: Date.now(),
    } as GeolocationPosition),
  );
  expect(useDirectionsStore.getState().waypoints[0].label).toBe("Provider Aachen");
  await screen.findAllByText("Provider Aachen");
  expect(screen.queryByText("directions.importedTrip")).toBeNull();
  expect(screen.queryByText("DB Navigator")).toBeNull();
  expect(useDirectionsStore.getState().transitItineraries[0]).toMatchObject({
    id: "provider-trip",
    legs: [{ from: { platformCode: "17" } }],
  });
});

it("still fills the same empty origin from ordinary auto-location", async () => {
  let giveFix: PositionCallback = () => {};
  vi.stubGlobal("navigator", {
    geolocation: {
      getCurrentPosition: vi.fn((...args: unknown[]) => {
        giveFix = args[0] as PositionCallback;
      }),
    },
  });
  useDirectionsStore.getState().open();
  renderPanel();
  await act(async () =>
    giveFix({
      coords: { longitude: 13, latitude: 52, accuracy: 5 },
      timestamp: Date.now(),
    } as GeolocationPosition),
  );
  expect(useDirectionsStore.getState().waypoints[0].coords).toEqual([13, 52]);
});
