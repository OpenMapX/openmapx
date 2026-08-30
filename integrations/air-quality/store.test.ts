import { afterEach, describe, expect, it } from "vitest";

import { useAirQualityStore } from "./store";

afterEach(() => useAirQualityStore.getState().reset());

describe("canonical air-quality overlay store", () => {
  it("defaults to one hidden PM2.5 monitor mode", () => {
    expect(useAirQualityStore.getState()).toMatchObject({
      panelOpen: false,
      layerVisible: false,
      mode: { kind: "monitors", pollutant: "pm25" },
      loading: false,
      error: null,
      warnings: [],
      truncated: false,
      hasData: false,
      stationCount: 0,
      activeSourceIds: [],
    });
  });

  it("switches modes atomically and applies only the selected mode's option", () => {
    useAirQualityStore.getState().setRasterFrame("2026-08-30T12:00:00.000Z");
    expect(useAirQualityStore.getState().mode).toEqual({
      kind: "eea-raster",
      frameTime: "2026-08-30T12:00:00.000Z",
    });

    useAirQualityStore.getState().setMonitorPollutant("o3");
    expect(useAirQualityStore.getState().mode).toEqual({ kind: "monitors", pollutant: "o3" });
    expect("frameTime" in useAirQualityStore.getState().mode).toBe(false);
  });

  it("tracks visibility and replaces request status without duplicate sources", () => {
    useAirQualityStore.getState().openPanel();
    useAirQualityStore.getState().setLoading(true);
    useAirQualityStore.getState().setSnapshotStatus({
      warnings: ["partial_providers", "quota_truncated"],
      truncated: true,
      activeSourceIds: ["openaq", "openaq", "fixture-source"],
      stationCount: 27,
    });

    expect(useAirQualityStore.getState()).toMatchObject({
      panelOpen: true,
      layerVisible: true,
      loading: false,
      error: null,
      warnings: ["partial_providers", "quota_truncated"],
      truncated: true,
      hasData: true,
      stationCount: 27,
      activeSourceIds: ["fixture-source", "openaq"],
    });

    useAirQualityStore.getState().setRequestError("unavailable");
    expect(useAirQualityStore.getState()).toMatchObject({
      error: "unavailable",
      hasData: true,
      activeSourceIds: ["fixture-source", "openaq"],
    });
  });

  it("keeps a completed snapshot when the selected pollutant is selected again", () => {
    useAirQualityStore.getState().setSnapshotStatus({
      warnings: ["partial_providers"],
      truncated: false,
      activeSourceIds: ["fixture-source"],
      stationCount: 3,
    });

    useAirQualityStore.getState().setMonitorPollutant("pm25");

    expect(useAirQualityStore.getState()).toMatchObject({
      mode: { kind: "monitors", pollutant: "pm25" },
      hasData: true,
      warnings: ["partial_providers"],
      activeSourceIds: ["fixture-source"],
      stationCount: 3,
    });
  });

  it("resets mode, visibility, loading, errors, and evidence metadata", () => {
    useAirQualityStore.getState().openPanel();
    useAirQualityStore.getState().setMonitorPollutant("pm10");
    useAirQualityStore.getState().setLoading(true);
    useAirQualityStore.getState().setRequestError("quota");
    useAirQualityStore.getState().reset();

    expect(useAirQualityStore.getState()).toMatchObject({
      panelOpen: false,
      layerVisible: false,
      mode: { kind: "monitors", pollutant: "pm25" },
      loading: false,
      error: null,
      warnings: [],
      truncated: false,
      hasData: false,
      stationCount: 0,
      activeSourceIds: [],
    });
  });
});
