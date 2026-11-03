import {
  type CategoryPlace,
  type DataSourceResult,
  type Route,
  useNavigationStore,
} from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@/test";
import { setPendingArrivalHandoff } from "./arrivalHandoffState";

const state = vi.hoisted(() => ({
  saveHere: vi.fn(async () => "saved" as const),
  completeArrival: vi.fn(async () => true),
  startGround: vi.fn(async () => ({ ok: true as const })),
}));

vi.mock("@/components/panels/parking/useSaveParking", () => ({
  useSaveParking: () => ({ saveHere: state.saveHere, isSaving: false }),
}));
vi.mock("@/lib/mobile/useNavigationMutations", () => ({
  useNavigationMutations: () => ({ completeArrival: state.completeArrival }),
}));
vi.mock("@/lib/mobile/useStartNavigation", () => ({
  useStartNavigation: () => ({ startGround: state.startGround }),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const fetchDirections = vi.fn();
const useCategorySearch = vi.fn(() => ({
  data: { results: [] as CategoryPlace[] },
  isLoading: false,
}));
const useDataSources = vi.fn(() => ({
  data: { sources: [] as { id: string }[] } as { sources: { id: string }[] } | undefined,
  isLoading: false,
}));
const useDataSourceSearch = vi.fn(() => ({
  data: undefined as DataSourceResult[] | undefined,
  isLoading: false,
  isError: false,
  partial: null as "area" | "unavailable" | null,
}));
vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchDirections: (...args: unknown[]) => fetchDirections(...args),
    useCategorySearch: (...args: unknown[]) => useCategorySearch(...args),
    useDataSources: () => useDataSources(),
    useDataSourceSearch: (...args: unknown[]) => useDataSourceSearch(...args),
  };
});

/** The bounded search area around the destination. */
const AREA = expect.objectContaining({ west: expect.any(Number), east: expect.any(Number) });

function site(id: string, offset: number, over: Partial<DataSourceResult> = {}): DataSourceResult {
  return {
    id,
    name: id,
    coordinates: [10.01 + offset / 1000, 50.01],
    source: "osm-parking",
    variant: "available",
    contributors: [{ sourceId: "osm-parking", name: "OpenStreetMap" }],
    ...over,
  };
}

function offerParkingSource(search: Partial<ReturnType<typeof useDataSourceSearch>> = {}): void {
  useDataSources.mockReturnValue({ data: { sources: [{ id: "parking" }] }, isLoading: false });
  useDataSourceSearch.mockReturnValue({
    data: [],
    isLoading: false,
    isError: false,
    partial: null,
    ...search,
  });
}

import { useArrivalHandoff } from "./useArrivalHandoff";

const drivingRoute: Route = {
  distance: 1000,
  duration: 300,
  geometry: [
    [10, 50],
    [10.01, 50.01],
  ],
  legs: [],
  steps: [],
  mode: "driving",
};

const walkingRoute: Route = {
  distance: 250,
  duration: 180,
  geometry: [
    [10.01, 50.01],
    [10.02, 50.02],
  ],
  legs: [],
  steps: [],
  mode: "walking",
};

describe("useArrivalHandoff", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.saveHere.mockResolvedValue("saved");
    state.startGround.mockResolvedValue({ ok: true });
    state.completeArrival.mockResolvedValue(true);
    fetchDirections.mockResolvedValue({ routes: [] });
    useCategorySearch.mockReturnValue({ data: { results: [] }, isLoading: false });
    useDataSources.mockReturnValue({ data: { sources: [] }, isLoading: false });
    useDataSourceSearch.mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: false,
      partial: null,
    });
    setPendingArrivalHandoff(null);
    useNavigationStore.setState({
      status: "arrived",
      kind: "ground",
      mode: "driving",
      route: drivingRoute,
      routeProvider: "valhalla",
      destinationWaypoints: [
        [10, 50],
        [10.01, 50.01],
      ],
      progress: {
        currentStepIndex: 0,
        distanceToNextManeuver: 0,
        distanceRemaining: 0,
        durationRemaining: 0,
        snapped: [10.01, 50.01],
        alongMeters: 1000,
        deviationMeters: 0,
        segmentIndex: 1,
        etaEpochMs: Date.now(),
        bearing: 45,
        speedMps: 0,
      },
    });
  });

  it("offers parking only after motorized ground arrivals", () => {
    const { result, rerender } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(result.current.canSaveParking).toBe(true);
    expect(result.current.showParkingOptions).toBe(true);
    act(() => useNavigationStore.setState({ mode: "walking" }));
    rerender();
    expect(result.current.canSaveParking).toBe(false);
  });

  it("saves parking only after the user asks", async () => {
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(state.saveHere).not.toHaveBeenCalled();
    await act(() => result.current.handleSaveParking());
    expect(state.saveHere).toHaveBeenCalledWith({ source: "arrival" });
    expect(result.current.isParkingSaved).toBe(true);
  });

  it("queries a bounded destination area and sorts the closest four places", () => {
    const places = [5, 1, 4, 2, 3].map((offset) => ({
      id: `p${offset}`,
      name: `P${offset}`,
      coordinates: [10.01 + offset / 1000, 50.01] as [number, number],
    }));
    useCategorySearch.mockReturnValue({ data: { results: places }, isLoading: false });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(useCategorySearch).toHaveBeenCalledWith(
      "parking",
      expect.objectContaining({ west: expect.any(Number), east: expect.any(Number) }),
      "en",
    );
    expect(result.current.nearbyParking.map((place) => place.id)).toEqual(["p1", "p2", "p3", "p4"]);
  });

  it("searches places for parking while no parking source is offered", () => {
    renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(useDataSourceSearch).toHaveBeenCalledWith(null, AREA, {});
    expect(useCategorySearch).toHaveBeenCalledWith("parking", AREA, "en");
  });

  it("waits for the source list before choosing where to search", () => {
    useDataSources.mockReturnValue({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(useCategorySearch).toHaveBeenLastCalledWith(null, AREA, "en");
    expect(result.current.isParkingLoading).toBe(true);
  });

  it("offers the parking source's sites a visitor may use, with fee and free spaces", () => {
    const spaces = { $t: "summary.spaces", values: { count: 12 } };
    offerParkingSource({
      data: [
        site("closed", 1, { status: "non-operational", variant: "closed" }),
        site("private", 2, { access: "private" }),
        site("permit", 3, { access: "permit" }),
        site("restricted", 4, { access: "restricted" }),
        site("garage", 7, { fee: "paid", summary: spaces }),
        site("shop", 6, { access: "customers", fee: "free" }),
        site("lot", 5, { access: "public" }),
        site("street", 8),
        site("far", 9),
      ],
    });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(useDataSourceSearch).toHaveBeenCalledWith("parking", AREA, {});
    expect(useCategorySearch).toHaveBeenLastCalledWith(null, AREA, "en");
    expect(result.current.nearbyParking.map((place) => place.id)).toEqual([
      "lot",
      "shop",
      "garage",
      "street",
    ]);
    const [lot, shop, garage] = result.current.nearbyParking;
    expect(lot?.osmTags).toBeUndefined();
    expect(shop?.osmTags).toEqual({ fee: "no" });
    expect(garage).toMatchObject({ osmTags: { fee: "yes" }, summary: spaces });
    expect(garage?.contributors).toEqual([{ sourceId: "osm-parking", name: "OpenStreetMap" }]);
  });

  it("ranks a site reported full after farther sites that may have room", () => {
    offerParkingSource({
      data: [
        site("full", 1, { variant: "full" }),
        site("open", 3, { variant: "available" }),
        site("stale", 2, { variant: "unknown" }),
      ],
    });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(result.current.nearbyParking.map((place) => place.id)).toEqual([
      "stale",
      "open",
      "full",
    ]);
  });

  it("reports the parking source's loading state", () => {
    offerParkingSource({ data: undefined, isLoading: true });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(result.current.isParkingLoading).toBe(true);
  });

  it.each<[string, Partial<ReturnType<typeof useDataSourceSearch>>]>([
    ["fails", { data: undefined, isError: true }],
    ["did not answer", { data: [], partial: "unavailable" }],
  ])("falls back to the place search when the parking source %s", (_, search) => {
    offerParkingSource(search);
    useCategorySearch.mockReturnValue({
      data: { results: [{ id: "poi", name: "POI", coordinates: [10.011, 50.01] }] },
      isLoading: false,
    });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(useCategorySearch).toHaveBeenLastCalledWith("parking", AREA, "en");
    expect(result.current.nearbyParking.map((place) => place.id)).toEqual(["poi"]);
  });

  it("does not request a zero-length walk at the original destination", () => {
    renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    expect(fetchDirections).not.toHaveBeenCalled();
  });

  it("restores the original destination after arriving at selected parking", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: "Museum",
    });
    fetchDirections.mockResolvedValue({ routes: [walkingRoute] });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    await waitFor(() => expect(result.current.walkingRoute).toEqual(walkingRoute));
    expect(result.current.destinationCoords).toEqual([10.02, 50.02]);
    expect(result.current.showParkingOptions).toBe(false);
    expect(fetchDirections).toHaveBeenCalledWith(
      expect.objectContaining({
        waypoints: [
          [10.01, 50.01],
          [10.02, 50.02],
        ],
        mode: "walking",
      }),
    );
  });

  it("rejects and clears a pending handoff for a different parking destination", () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.02, 50.02],
      destinationCoords: [10.03, 50.03],
      destinationName: "Wrong session",
    });

    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));

    expect(result.current.destinationName).toBeNull();
    expect(result.current.showParkingOptions).toBe(true);
  });

  it("starts the walking leg through the authority-aware navigation adapter", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: null,
    });
    fetchDirections.mockResolvedValue({ routes: [walkingRoute] });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    await waitFor(() => expect(result.current.walkingRoute).toEqual(walkingRoute));
    await act(() => result.current.handleStartWalking());
    expect(state.completeArrival).toHaveBeenCalledTimes(1);
    expect(state.startGround).toHaveBeenCalledWith(
      expect.objectContaining({
        route: walkingRoute,
        mode: "walking",
        destinationWaypoints: [
          [10.01, 50.01],
          [10.02, 50.02],
        ],
      }),
    );
  });

  it("preserves the provider returned with a planned walking route", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: null,
    });
    fetchDirections.mockResolvedValue({ routes: [walkingRoute], provider: "openroute" });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    await waitFor(() => expect(result.current.walkingRoute).toEqual(walkingRoute));

    await act(() => result.current.handleStartWalking());

    expect(state.startGround).toHaveBeenCalledWith(
      expect.objectContaining({ routeProvider: "openroute" }),
    );
  });

  it("does not start a continuation if completing the arrived session fails", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: null,
    });
    state.completeArrival.mockResolvedValue(false);
    fetchDirections.mockResolvedValue({ routes: [walkingRoute], provider: "openroute" });
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    await waitFor(() => expect(result.current.walkingRoute).toEqual(walkingRoute));

    await expect(act(() => result.current.handleStartWalking())).resolves.toBe(false);
    expect(state.startGround).not.toHaveBeenCalled();
  });

  it("converts a rejected walking start into a failed handoff result", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: null,
    });
    fetchDirections.mockResolvedValue({ routes: [walkingRoute] });
    state.startGround.mockRejectedValue(new Error("start failed"));
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    await waitFor(() => expect(result.current.walkingRoute).toEqual(walkingRoute));

    await expect(act(() => result.current.handleStartWalking())).resolves.toBe(false);
  });

  it("guards two same-tick walking actions synchronously", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: null,
    });
    fetchDirections.mockResolvedValue({ routes: [walkingRoute] });
    let releaseCompletion!: (value: boolean) => void;
    state.completeArrival.mockReturnValue(
      new Promise<boolean>((resolve) => {
        releaseCompletion = resolve;
      }),
    );
    const { result } = renderHook(() => useArrivalHandoff({ onClose: vi.fn() }));
    await waitFor(() => expect(result.current.walkingRoute).toEqual(walkingRoute));

    let first!: Promise<boolean>;
    let second!: Promise<boolean>;
    act(() => {
      first = result.current.handleStartWalking();
      second = result.current.handleStartWalking();
    });
    await expect(second).resolves.toBe(false);
    releaseCompletion(true);
    await expect(first).resolves.toBe(true);
    expect(state.completeArrival).toHaveBeenCalledTimes(1);
    expect(state.startGround).toHaveBeenCalledTimes(1);
  });

  it("routes motorcycles to parking as motorcycles and preserves the final destination", async () => {
    act(() => useNavigationStore.setState({ mode: "motorcycle" }));
    const parkingRoute = { ...drivingRoute, mode: "motorcycle" as const };
    fetchDirections.mockResolvedValue({ routes: [parkingRoute], provider: "valhalla" });
    const parking: CategoryPlace = {
      id: "p1",
      name: "Garage",
      coordinates: [10.015, 50.015],
    };
    const { result } = renderHook(() =>
      useArrivalHandoff({ onClose: vi.fn(), destinationName: "Museum" }),
    );
    await act(() => result.current.handleDriveToParking(parking));
    expect(fetchDirections).toHaveBeenCalledWith(expect.objectContaining({ mode: "motorcycle" }));
    expect(state.completeArrival).toHaveBeenCalledTimes(1);
    expect(state.startGround).toHaveBeenCalledWith(
      expect.objectContaining({ mode: "motorcycle", route: parkingRoute }),
    );
  });

  it("clears pending handoff state when Done closes the arrival card", () => {
    const onClose = vi.fn();
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.02, 50.02],
      destinationName: null,
    });
    const { result } = renderHook(() => useArrivalHandoff({ onClose }));
    act(() => result.current.handleDone());
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
