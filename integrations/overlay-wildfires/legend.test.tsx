import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@/test";
import { useWildfireStore } from "./store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { WildfireLegend } from "./legend";

beforeEach(() => {
  useWildfireStore.setState({
    panelOpen: true,
    layerVisible: true,
    showHotspots: true,
    showNifcPerimeters: true,
    showEffisBurnedAreas: true,
    showNoaaSmoke: false,
    showHeatmap: false,
  });
  for (const sourceId of ["firms", "nifc", "effis", "noaa-hms"] as const) {
    useWildfireStore.getState().resetSourceStatus(sourceId);
  }
});

describe("WildfireLegend multi-source controls and status", () => {
  it("offers independent source toggles while observed smoke remains off by default", () => {
    render(<WildfireLegend />);

    expect(screen.getByLabelText("wildfires.hotspotDetections")).toBeChecked();
    expect(screen.getByLabelText("wildfires.nifcPerimeters")).toBeChecked();
    expect(screen.getByLabelText("wildfires.effisBurnedAreas")).toBeChecked();
    expect(screen.getByLabelText("wildfires.observedSmoke")).not.toBeChecked();

    fireEvent.click(screen.getByLabelText("wildfires.observedSmoke"));
    expect(useWildfireStore.getState().showNoaaSmoke).toBe(true);
    expect(useWildfireStore.getState().showHotspots).toBe(true);
    expect(useWildfireStore.getState().showNifcPerimeters).toBe(true);
    expect(useWildfireStore.getState().showEffisBurnedAreas).toBe(true);
  });

  it("shows loading only when an enabled source is loading", () => {
    useWildfireStore.getState().setSourceStatus("noaa-hms", { loading: true });
    const view = render(<WildfireLegend />);
    expect(screen.queryByRole("progressbar")).toBeNull();

    act(() => useWildfireStore.getState().setSourceStatus("nifc", { loading: true }));
    expect(screen.getByRole("progressbar")).toBeTruthy();

    view.unmount();
  });

  it("summarizes enabled source failures, stale data, and the newest update", () => {
    useWildfireStore.getState().setSourceStatus("firms", { fetchedAt: 100 });
    useWildfireStore.getState().setSourceStatus("nifc", { fetchedAt: 300, stale: true });
    useWildfireStore.getState().setSourceStatus("effis", { error: "unavailable" });
    useWildfireStore.getState().setSourceStatus("noaa-hms", {
      fetchedAt: 900,
      stale: true,
      error: "unavailable",
    });

    render(<WildfireLegend />);

    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("wildfires.sourceUnavailable");
    expect(status).toHaveTextContent("wildfires.staleData");
    expect(status).toHaveTextContent("wildfires.lastUpdated");
    expect(status).toHaveAttribute("data-last-updated", "300");
    expect(status).toHaveAttribute("data-error-count", "1");
  });

  it("keeps FIRMS age, sensor, heatmap, recency, and fire-power controls scoped to hotspots", () => {
    useWildfireStore.setState({ showHotspots: false });
    render(<WildfireLegend />);

    expect(screen.queryByText("wildfires.dayRange")).toBeNull();
    expect(screen.queryByText("wildfires.sensor")).toBeNull();
    expect(screen.queryByText("wildfires.recencyScale")).toBeNull();
    expect(screen.queryByText("wildfires.frpSize")).toBeNull();
    expect(screen.queryByLabelText("wildfires.heatmap")).toBeNull();
    expect(screen.getByLabelText("wildfires.nifcPerimeters")).toBeChecked();
  });
});
