import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createQueryWrapper, fireEvent, render, screen, waitFor } from "@/test";

vi.mock("next-intl", async () =>
  (await import("@/test/intl")).mockNextIntl({ useLocale: () => "de" }),
);

const useDirectionsMock = vi.fn();
const useTransitPlanMock = vi.fn();
const useAutocompleteMock = vi.fn();
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useDirections: (...a: unknown[]) => useDirectionsMock(...a),
    useTransitPlan: (...a: unknown[]) => useTransitPlanMock(...a),
    useAutocomplete: (...a: unknown[]) => useAutocompleteMock(...a),
    useCapabilities: () => ({ services: {} }),
    useOptimizeRoute: () => ({ mutate: vi.fn(), isPending: false }),
    useRouteInGermany: () => ({ bothInGermany: false }),
  };
});

// TransitItineraryCard's real mount needs ~8 module mocks (see its own spec);
// stub it — this spec only asserts DirectionsPanelContent DELEGATES to it.
vi.mock("@/components/panels/directions/TransitRouteView", () => ({
  TransitItineraryCard: ({ itinerary }: { itinerary: { duration: number } }) => (
    <div data-testid="transit-itinerary-card">{itinerary.duration}</div>
  ),
}));

import { useDirectionsStore, useMapStore, useSidebarStore } from "@openmapx/core";
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
  useDirectionsMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useTransitPlanMock
    .mockReset()
    .mockReturnValue({ data: undefined, isLoading: false, isError: false });
  useAutocompleteMock.mockReset().mockReturnValue({ data: [] });
  act(() => {
    useDirectionsStore.getState().close();
    useDirectionsStore.getState().setMode("driving");
    useSidebarStore.setState({ activeSidebarId: null });
    useMapStore.setState({ userLocation: null });
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

    expect(useDirectionsStore.getState().origin).toEqual([13.405, 52.52]);
    expect(useDirectionsStore.getState().originLabel).toBe("directions.myLocation");
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

  it("driving depart/arrive time feeds the request after the debounce", async () => {
    seedOriginDestination();
    renderPanel();

    fireEvent.click(screen.getByText("directions.departNow"));
    const departAtTab = screen.getByText("directions.departAt");
    fireEvent.click(departAtTab);

    const dtInput = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    expect(dtInput).not.toBeNull();
    fireEvent.change(dtInput, { target: { value: "2026-07-04T09:30" } });

    await waitFor(() => {
      const arg = lastArg<DirectionsCallArgs>(useDirectionsMock);
      expect(arg.departAt).toBe("2026-07-04T09:30");
    });
    expect(lastArg<DirectionsCallArgs>(useDirectionsMock).arriveBy).toBe(undefined);

    const arriveByTab = screen.getByText("directions.arriveBy");
    fireEvent.click(arriveByTab);
    const dtInput2 = document.querySelector('input[type="datetime-local"]') as HTMLInputElement;
    fireEvent.change(dtInput2, { target: { value: "2026-07-04T18:00" } });

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

  it("transit error state renders transitNotAvailable", () => {
    seedOriginDestination();
    act(() => {
      useDirectionsStore.getState().setMode("transit");
    });
    useTransitPlanMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    renderPanel();
    screen.getByText("directions.transitNotAvailable");
  });

  it("road-mode error state renders noRoutesFound", () => {
    seedOriginDestination();
    useDirectionsMock.mockReturnValue({ data: undefined, isLoading: false, isError: true });

    renderPanel();
    screen.getByText("directions.noRoutesFound");
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
