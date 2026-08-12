import { beforeEach, describe, expect, it } from "vitest";
import { useWildfireStore, type WildfireSourceStatus } from "./store.js";

const IDLE_STATUS: WildfireSourceStatus = {
  loading: false,
  fetchedAt: null,
  stale: false,
  truncated: false,
  error: null,
  featureCount: null,
};

const MODULE_DEFAULTS = useWildfireStore.getState();

describe("useWildfireStore", () => {
  beforeEach(() => {
    useWildfireStore.setState({
      panelOpen: false,
      layerVisible: false,
      showHotspots: true,
      showNifcPerimeters: true,
      showEffisBurnedAreas: true,
      showNoaaSmoke: false,
      showHeatmap: false,
      dayRange: 1,
      statuses: {
        firms: { ...IDLE_STATUS },
        nifc: { ...IDLE_STATUS },
        effis: { ...IDLE_STATUS },
        "noaa-hms": { ...IDLE_STATUS },
      },
    });
  });

  it("starts with FIRMS, NIFC, and EFFIS visible while smoke and heatmap are opt-in", () => {
    expect(MODULE_DEFAULTS).toMatchObject({
      showHotspots: true,
      showNifcPerimeters: true,
      showEffisBurnedAreas: true,
      showNoaaSmoke: false,
      showHeatmap: false,
    });
  });

  it("changes each source visibility without changing the other source choices", () => {
    const state = useWildfireStore.getState();
    state.setShowHotspots(false);
    state.setShowNifcPerimeters(false);
    state.setShowEffisBurnedAreas(false);
    state.setShowNoaaSmoke(true);

    expect(useWildfireStore.getState()).toMatchObject({
      showHotspots: false,
      showNifcPerimeters: false,
      showEffisBurnedAreas: false,
      showNoaaSmoke: true,
      dayRange: 1,
    });
  });

  it("updates one source status without leaking into another source", () => {
    useWildfireStore.getState().setSourceStatus("nifc", {
      loading: true,
      fetchedAt: 1_786_553_040_000,
      featureCount: 12,
    });

    expect(useWildfireStore.getState().statuses.nifc).toEqual({
      ...IDLE_STATUS,
      loading: true,
      fetchedAt: 1_786_553_040_000,
      featureCount: 12,
    });
    expect(useWildfireStore.getState().statuses.effis).toEqual(IDLE_STATUS);
  });

  it("preserves sublayer choices when the master overlay closes", () => {
    const state = useWildfireStore.getState();
    state.setShowHotspots(false);
    state.setShowNoaaSmoke(true);
    state.openPanel();
    useWildfireStore.getState().closePanel();

    expect(useWildfireStore.getState()).toMatchObject({
      panelOpen: false,
      layerVisible: false,
      showHotspots: false,
      showNifcPerimeters: true,
      showEffisBurnedAreas: true,
      showNoaaSmoke: true,
    });
  });

  it("resets only the source whose component unmounts", () => {
    const state = useWildfireStore.getState();
    state.setSourceStatus("nifc", { loading: true, stale: true, error: "unavailable" });
    state.setSourceStatus("effis", { fetchedAt: 1_786_553_040_000, featureCount: 7 });

    useWildfireStore.getState().resetSourceStatus("nifc");

    expect(useWildfireStore.getState().statuses.nifc).toEqual(IDLE_STATUS);
    expect(useWildfireStore.getState().statuses.effis).toEqual({
      ...IDLE_STATUS,
      fetchedAt: 1_786_553_040_000,
      featureCount: 7,
    });
  });
});
