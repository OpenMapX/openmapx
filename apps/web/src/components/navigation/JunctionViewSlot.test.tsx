import type { Route } from "@openmapx/core";
import { useNavigationStore, useSettingsStore } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const { JunctionViewSlot } = await import("./JunctionViewSlot");
const { useNavJunctionStore } = await import("@/lib/navigation/junctionStore");
const fixture = await import(
  "../../../../../packages/core/src/navigation/__fixtures__/junction/a57-neuss-exit20.json"
);
const { findJunctionDecisionPoints } = await import("@openmapx/core");

const a57Route = fixture.route as unknown as Route;
const decisionPoints = findJunctionDecisionPoints(a57Route);

function populateStore(): void {
  useNavJunctionStore.getState().setDecisionPoints("route-1", decisionPoints);
}

const baseProgress = {
  currentStepIndex: 0,
  distanceToNextManeuver: 400,
  distanceRemaining: 1400,
  durationRemaining: 80,
  snapped: [6.676, 51.179] as [number, number],
  alongMeters: 1000,
  deviationMeters: 0,
  segmentIndex: 0,
  etaEpochMs: 0,
  bearing: 283,
  speedMps: 30,
};

function setState(overrides: Record<string, unknown> = {}): void {
  useNavigationStore.setState({
    kind: "ground",
    status: "navigating",
    mode: "driving",
    route: a57Route,
    progress: baseProgress,
    ...overrides,
  });
}

function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <JunctionViewSlot />
    </QueryClientProvider>,
  );
}

describe("JunctionViewSlot", () => {
  beforeEach(() => {
    useSettingsStore.setState({ junctionView: true, junctionPhotos: true });
    useNavJunctionStore.getState().reset();
    populateStore();
  });

  afterEach(() => {
    cleanup();
    useNavigationStore.getState().stopNavigation();
    useNavJunctionStore.getState().reset();
  });

  it("renders the panel inside the approach window before the exit", () => {
    setState();
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeTruthy();
  });

  it("holds the photo back until the exit is close, showing the gantry meanwhile", () => {
    const photo = {
      status: "ready" as const,
      image: {
        id: "photo-1",
        providerId: "panoramax",
        lngLat: [6.678013787, 51.1787552] as [number, number],
        heading: 282,
        capturedAt: "2019-09-10T06:24:34Z",
        isPano: false,
        fovDeg: 70,
        assets: {},
        author: "motocultrice",
        license: "CC BY-SA 4.0",
      },
      objectUrl: "blob:photo-1",
    };
    useNavJunctionStore.getState().setPhoto(decisionPoints[0].stepIndex, photo);
    // 2 km out at motorway speed: inside the guidance window, well outside the
    // photo's own, so the card shows the schematic.
    setState({
      progress: { ...baseProgress, distanceToNextManeuver: 2000 },
    });
    const far = mount();
    expect(far.queryByTestId("junction-view-panel")).toBeTruthy();
    expect(far.queryByTestId("junction-photo")).toBeNull();
    cleanup();

    setState({ progress: { ...baseProgress, distanceToNextManeuver: 700 } });
    const near = mount();
    expect(near.queryByTestId("junction-photo")).toBeTruthy();
  });

  it("renders nothing far from the maneuver", () => {
    setState({
      progress: {
        currentStepIndex: 0,
        distanceToNextManeuver: 5000,
        distanceRemaining: 1400,
        durationRemaining: 80,
        snapped: [6.676, 51.179],
        alongMeters: 0,
        deviationMeters: 0,
        segmentIndex: 0,
        etaEpochMs: 0,
        bearing: 283,
        speedMps: 30,
      },
    });
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeNull();
  });

  it("renders nothing when junctionView is off", () => {
    setState();
    useSettingsStore.setState({ junctionView: false });
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeNull();
  });

  it("hides the moment the step advances past the exit", () => {
    setState({ progress: { currentStepIndex: 1, distanceToNextManeuver: 200 } });
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeNull();
  });

  it("renders nothing for cycling", () => {
    setState({ mode: "cycling" });
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeNull();
  });

  it("renders nothing after arrival", () => {
    setState({ status: "arrived" });
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeNull();
  });

  it("hands the prefetched photo to the panel once its bytes are in", () => {
    setState();
    useNavJunctionStore.getState().setPhoto(1, {
      status: "ready",
      image: {
        id: "photo-1",
        providerId: "panoramax",
        lngLat: [6.679, 51.1786],
        heading: 283,
        capturedAt: "2019-09-10T06:24:40+00:00",
        isPano: false,
        fovDeg: 70,
        assets: {},
        author: "motocultrice",
        license: "CC BY-SA 4.0",
      },
      objectUrl: "blob:photo-1",
    });
    const view = mount();
    expect(view.queryByTestId("junction-photo")).toBeTruthy();
    expect(view.queryByTestId("junction-schematic")).toBeNull();

    // Switched off mid-drive: a photo already fetched goes too.
    act(() => {
      useSettingsStore.setState({ junctionPhotos: false });
    });
    expect(view.queryByTestId("junction-photo")).toBeNull();
    expect(view.queryByTestId("junction-schematic")).toBeTruthy();
  });

  it("renders nothing for a decision point with no sign and no lanes", () => {
    const barePoint = {
      ...decisionPoints[0],
      sign: undefined,
      laneCount: undefined,
      activeLanes: [],
    };
    useNavJunctionStore.getState().setDecisionPoints("route-1", [barePoint]);
    setState();
    const view = mount();
    expect(view.queryByTestId("junction-view-panel")).toBeNull();
  });
});
