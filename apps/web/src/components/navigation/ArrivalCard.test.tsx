import type { CategoryPlace, Route } from "@openmapx/core";
import { useNavigationStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";
import { setPendingArrivalHandoff } from "./arrivalHandoffState";

const state = vi.hoisted(() => ({ saveHere: vi.fn(async () => "saved" as const) }));

vi.mock("@/components/panels/parking/useSaveParking", () => ({
  useSaveParking: () => ({ saveHere: state.saveHere, saveAt: vi.fn(), isSaving: false }),
}));

const mockFetchDirections = vi.fn();
const mockUseCategorySearch = vi.fn(() => ({
  data: { results: [] as CategoryPlace[] },
  isLoading: false,
}));

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    fetchDirections: (...args: unknown[]) => mockFetchDirections(...args),
    useCategorySearch: (...args: unknown[]) => mockUseCategorySearch(...args),
  };
});

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { ArrivalCard } from "./ArrivalCard";

const mockRoute: Route = {
  distance: 1000,
  duration: 300,
  geometry: [
    [10.0, 50.0],
    [10.01, 50.01],
  ],
  legs: [],
  steps: [],
  mode: "driving",
};

const mockWalkingRoute: Route = {
  distance: 250,
  duration: 180,
  geometry: [
    [10.01, 50.01],
    [10.012, 50.012],
  ],
  legs: [],
  steps: [],
  mode: "walking",
};

const sampleParkingPlaces: CategoryPlace[] = [
  { id: "p1", name: "Garage Central", coordinates: [10.011, 50.011] },
  { id: "p2", name: "Street Parking", coordinates: [10.012, 50.012] },
];

beforeEach(() => {
  setPendingArrivalHandoff(null);
  state.saveHere.mockClear();
  mockFetchDirections.mockReset();
  mockFetchDirections.mockResolvedValue({ routes: [] });
  mockUseCategorySearch.mockReturnValue({
    data: { results: [] },
    isLoading: false,
  });
  useNavigationStore.setState({
    status: "arrived",
    kind: "ground",
    mode: "driving",
    route: mockRoute,
    destinationWaypoints: [
      [10.0, 50.0],
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

describe("ArrivalCard", () => {
  it("offers Save parking after a drive", () => {
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /parking.saveParking/ })).toBeInTheDocument();
  });

  it("offers it after a motorcycle trip", () => {
    useNavigationStore.setState({ kind: "ground", mode: "motorcycle" });
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.getByRole("button", { name: /parking.saveParking/ })).toBeInTheDocument();
  });

  it("hides it after a walk", () => {
    useNavigationStore.setState({ kind: "ground", mode: "walking" });
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /parking.saveParking/ })).toBeNull();
  });

  it("hides it for a transit arrival", () => {
    useNavigationStore.setState({ kind: "transit", mode: "driving" });
    render(<ArrivalCard onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /parking.saveParking/ })).toBeNull();
  });

  it("labels the save as an arrival and never saves without a press", async () => {
    render(<ArrivalCard onClose={() => {}} />);
    expect(state.saveHere).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /parking.saveParking/ }));
    await waitFor(() => expect(state.saveHere).toHaveBeenCalledWith({ source: "arrival" }));
  });

  it("keeps Done as the primary action", async () => {
    const onClose = vi.fn();
    render(<ArrivalCard onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "navigation.done" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("renders WalkingHandoffCard when walking route is available", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.012, 50.012],
      destinationName: null,
    });
    mockFetchDirections.mockResolvedValue({ routes: [mockWalkingRoute] });
    render(<ArrivalCard onClose={() => {}} />);

    await waitFor(() => {
      expect(screen.getByText("navigation.walkToDestination")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "navigation.startWalking" })).toBeInTheDocument();
    });
  });

  it("renders the destination name when provided", async () => {
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.012, 50.012],
      destinationName: "City Museum",
    });
    mockFetchDirections.mockResolvedValue({ routes: [mockWalkingRoute] });
    render(<ArrivalCard onClose={() => {}} destinationName="City Museum" />);

    expect(screen.getByText("City Museum")).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText("navigation.walkToDestination")).toBeInTheDocument(),
    );
  });

  it("renders NearbyParkingCarousel when parking options are returned", () => {
    mockUseCategorySearch.mockReturnValue({
      data: { results: sampleParkingPlaces },
      isLoading: false,
    });
    render(<ArrivalCard onClose={() => {}} />);

    expect(screen.getByText(/navigation.nearbyParking/)).toBeInTheDocument();
    expect(screen.getByText("Garage Central")).toBeInTheDocument();
    expect(screen.getByText("Street Parking")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "navigation.driveHere" })).toHaveLength(2);
  });

  it("starts walking navigation when clicking Start walking", async () => {
    const startGroundNav = vi.fn();
    useNavigationStore.setState({ startGroundNavigation: startGroundNav });
    setPendingArrivalHandoff({
      parkingCoords: [10.01, 50.01],
      destinationCoords: [10.012, 50.012],
      destinationName: null,
    });
    mockFetchDirections.mockResolvedValue({ routes: [mockWalkingRoute] });

    render(<ArrivalCard onClose={() => {}} />);

    const startWalkBtn = await screen.findByRole("button", { name: "navigation.startWalking" });
    await userEvent.click(startWalkBtn);

    expect(startGroundNav).toHaveBeenCalledWith(
      mockWalkingRoute,
      "walking",
      [
        [10.01, 50.01],
        [10.012, 50.012],
      ],
      [],
      undefined,
      expect.objectContaining({ routeIntent: "userSelected" }),
    );
  });

  it("drives to parking when clicking Drive here on a carousel place", async () => {
    const startGroundNav = vi.fn();
    useNavigationStore.setState({ startGroundNavigation: startGroundNav });

    const driveToParkingRoute: Route = {
      distance: 350,
      duration: 90,
      geometry: [
        [10.01, 50.01],
        [10.011, 50.011],
      ],
      legs: [],
      steps: [],
      mode: "driving",
    };

    mockUseCategorySearch.mockReturnValue({
      data: { results: sampleParkingPlaces },
      isLoading: false,
    });
    mockFetchDirections.mockResolvedValue({ routes: [driveToParkingRoute] });

    render(<ArrivalCard onClose={() => {}} />);

    const driveHereBtns = screen.getAllByRole("button", { name: "navigation.driveHere" });
    await userEvent.click(driveHereBtns[0]);

    await waitFor(() => {
      expect(startGroundNav).toHaveBeenCalledWith(
        driveToParkingRoute,
        "driving",
        [
          [10.01, 50.01],
          [10.011, 50.011],
        ],
        [],
        undefined,
        expect.objectContaining({ routeIntent: "userSelected" }),
      );
    });
  });

  it("announces a failed parking continuation", async () => {
    mockUseCategorySearch.mockReturnValue({
      data: { results: sampleParkingPlaces },
      isLoading: false,
    });
    mockFetchDirections.mockResolvedValue({ routes: [] });

    render(<ArrivalCard onClose={() => {}} />);
    await userEvent.click(screen.getAllByRole("button", { name: "navigation.driveHere" })[0]);

    expect(await screen.findByText("navigation.handoffFailed")).toBeInTheDocument();
  });

  it("hides walking handoff and parking features for walking arrivals", () => {
    mockUseCategorySearch.mockReturnValue({
      data: { results: sampleParkingPlaces },
      isLoading: false,
    });
    useNavigationStore.setState({ kind: "ground", mode: "walking" });

    render(<ArrivalCard onClose={() => {}} />);

    expect(screen.queryByText(/navigation.nearbyParking/)).toBeNull();
    expect(screen.queryByText("navigation.startWalking")).toBeNull();
  });
});
