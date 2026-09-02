import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent } from "@/test";

import { TravelTimeToolbar } from "../legend";
import { useTravelTimeStore } from "../store";

const reachability = vi.hoisted(() => vi.fn());
const isochrone = vi.hoisted(() => vi.fn());

vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useIsochrone: () => ({ data: undefined, isFetching: false }),
  useTransitReachability: () => reachability(),
  useTransitIsochrone: () => isochrone(),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

function capabilities(exportableIsochrones: boolean) {
  return {
    estimatedSurface: true,
    exactPointChecks: false,
    exactPointCheckReason: "operator-disabled" as const,
    exportableIsochrones,
    exportableIsochroneReason: exportableIsochrones
      ? ("available" as const)
      : ("polygons-disabled" as const),
    maxDestinationsPerBatch: 128,
    maxTravelTimeMinutes: 90,
    datasetEpoch: "epoch-1",
  };
}

function setSurface(exportableIsochrones: boolean) {
  reachability.mockReturnValue({
    data: { capabilities: capabilities(exportableIsochrones), seeds: [] },
    attributions: [],
    isFetching: false,
  });
}

beforeEach(() => {
  reachability.mockReset();
  isochrone.mockReset();
  isochrone.mockReturnValue({ data: undefined, isFetching: false, error: null });
  setSurface(true);
  useTravelTimeStore.getState().activate();
  useTravelTimeStore.getState().setOrigin([13.4, 52.5]);
  useTravelTimeStore.getState().setMode("transit");
});

describe("travel-time legend polygon controls", () => {
  it("hides the surface switch when the deployment has not enabled polygons", () => {
    setSurface(false);
    render(<TravelTimeToolbar />);
    expect(screen.queryByText("travelTime.surfaceKindPolygons")).toBeNull();
  });

  it("offers the switch when polygons are enabled", () => {
    render(<TravelTimeToolbar />);
    expect(screen.getByText("travelTime.surfaceKindPolygons")).toBeVisible();
  });

  it("does not sample until the user asks, and offers no download before a result", async () => {
    render(<TravelTimeToolbar />);
    await userEvent.click(screen.getByText("travelTime.surfaceKindPolygons"));

    expect(useTravelTimeStore.getState().transitPolygonBbox).toBeNull();
    expect(screen.getByText("travelTime.generatePolygons")).toBeVisible();
    expect(screen.queryByText("travelTime.downloadGeoJson")).toBeNull();
  });

  it("states the accuracy as visible text rather than hiding it in a tooltip", async () => {
    render(<TravelTimeToolbar />);
    await userEvent.click(screen.getByText("travelTime.surfaceKindPolygons"));
    expect(screen.getByText("travelTime.polygonAccuracy")).toBeVisible();
  });

  it("freezes the viewport when the user generates polygons", async () => {
    useTravelTimeStore.getState().setTransitPolygonViewport([13.3, 52.45, 13.5, 52.55]);
    render(<TravelTimeToolbar />);
    await userEvent.click(screen.getByText("travelTime.surfaceKindPolygons"));
    await userEvent.click(screen.getByText("travelTime.generatePolygons"));
    expect(useTravelTimeStore.getState().transitPolygonBbox).toEqual([13.3, 52.45, 13.5, 52.55]);
  });

  it("offers the download once a sampled result exists", async () => {
    isochrone.mockReturnValue({
      data: {
        queryTime: "2026-09-01T08:00:00.000Z",
        sampling: { sampleCount: 2048, resolutionMetres: 663, clippedToBbox: false },
        featureCollection: { type: "FeatureCollection", features: [] },
      },
      isFetching: false,
      error: null,
    });
    render(<TravelTimeToolbar />);
    await userEvent.click(screen.getByText("travelTime.surfaceKindPolygons"));
    expect(screen.getByText("travelTime.downloadGeoJson")).toBeVisible();
  });

  it("warns when the requested area was clipped, so a cut edge is not read as a boundary", async () => {
    isochrone.mockReturnValue({
      data: {
        queryTime: "2026-09-01T08:00:00.000Z",
        sampling: { sampleCount: 2048, resolutionMetres: 663, clippedToBbox: true },
        featureCollection: { type: "FeatureCollection", features: [] },
      },
      isFetching: false,
      error: null,
    });
    render(<TravelTimeToolbar />);
    await userEvent.click(screen.getByText("travelTime.surfaceKindPolygons"));
    expect(screen.getByText("travelTime.polygonClipped")).toBeVisible();
  });

  it("keeps the estimated field available after a failed sampling run", async () => {
    isochrone.mockReturnValue({
      data: undefined,
      isFetching: false,
      error: new Error("upstream"),
    });
    render(<TravelTimeToolbar />);
    await userEvent.click(screen.getByText("travelTime.surfaceKindPolygons"));
    expect(screen.getByText("travelTime.polygonFailed")).toBeVisible();
    expect(screen.getByText("travelTime.surfaceKindEstimated")).toBeVisible();
  });
});
