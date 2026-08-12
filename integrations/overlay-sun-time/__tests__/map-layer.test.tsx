import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { layerRegistrations } from "@/components/map/layers/layerStack";
import { INTERACTIVE_LAYER_IDS } from "@/lib/interactiveLayers";
import { act, createFakeMap, type FakeMap, render } from "@/test";
import { useSunTimeStore } from "../store";

// Stubbed the same way overlay-environment's map-layer test stubs it: a
// minimal Popup double that records what was actually shown, so a test can
// assert on the rendered HTML without a real MapLibre popup/DOM anchor.
interface FakePopupInstance {
  lngLat: unknown;
  html: string;
  removed: boolean;
}
let popupInstances: FakePopupInstance[] = [];
vi.mock("maplibre-gl", () => ({
  Popup: class FakePopup {
    private record: FakePopupInstance = { lngLat: undefined, html: "", removed: false };
    constructor() {
      popupInstances.push(this.record);
    }
    setLngLat(lngLat: unknown) {
      this.record.lngLat = lngLat;
      return this;
    }
    setHTML(html: string) {
      this.record.html = html;
      return this;
    }
    addTo() {
      return this;
    }
    remove() {
      this.record.removed = true;
      return this;
    }
  },
}));

let fake: FakeMap;

// The real useMap() hands out a `useRef` — one stable object across every
// render of the caller. A fresh `{ current: fake.map }` literal per call (the
// obvious mock) breaks that contract: the sync effect's dependency array
// would see a "new" mapRef on every re-render and tear the whole layer down
// and rebuild it, independent of whether `active`/`tzActive` actually
// changed — masking exactly the kind of redundant-rebuild regression the
// "skips re-publishing" test below exists to catch.
const mapRefBox: { current: FakeMap["map"] | null } = { current: null };

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: mapRefBox,
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/lib/EnvProvider", () => ({ useEnv: () => ({ apiUrl: "http://api.test" }) }));

// jsdom never decodes images, so a real `Image.onload` would never fire and
// the icon-load path in map-layer.tsx would hang forever under test. Stub the
// global so setting `.src` resolves the load synchronously.
class StubImage {
  width: number;
  height: number;
  onload: (() => void) | null = null;
  constructor(width = 0, height = 0) {
    this.width = width;
    this.height = height;
  }
  set src(_value: string) {
    this.onload?.();
  }
}
vi.stubGlobal("Image", StubImage);

import SunTimeLayer from "../map-layer";

const SOURCE_ID = "sun-time-terminator";
const BAND_LAYER_IDS = Array.from({ length: 16 }, (_, i) => `sun-time-band-${i}`);
const SUBSOLAR_SOURCE_ID = "sun-time-subsolar-src";
const SUBSOLAR_LAYER_ID = "sun-time-subsolar";
const SUBSOLAR_IMAGE_ID = "sun-time-sun";
const TZ_SOURCE_ID = "sun-time-timezones";
const TZ_FILL_LAYER_ID = "sun-time-tz-fill";
const TZ_LINE_LAYER_ID = "sun-time-tz-line";
const TZ_LABEL_LAYER_ID = "sun-time-tz-label";

const TZ_FIXTURE = {
  type: "FeatureCollection",
  features: [
    {
      type: "Feature",
      properties: { tzid: "Europe/Berlin" },
      geometry: {
        type: "Polygon",
        coordinates: [
          [
            [13, 52],
            [14, 52],
            [14, 53],
            [13, 52],
          ],
        ],
      },
    },
  ],
};

beforeEach(() => {
  fake = createFakeMap();
  mapRefBox.current = fake.map;
  popupInstances = [];
  useSunTimeStore.setState({
    layerVisible: true,
    showTerminator: true,
    timeMs: 1_700_000_000_000,
  });
});

afterEach(() => {
  useSunTimeStore.setState({
    layerVisible: false,
    panelOpen: false,
    timeMs: null,
    showTimeZones: false,
  });
  vi.useRealTimers();
});

describe("SunTimeLayer", () => {
  it("adds one fill layer per twilight band", () => {
    render(<SunTimeLayer />);

    for (const id of BAND_LAYER_IDS) {
      expect(fake.state.layers.get(id)?.type).toBe("fill");
    }
    expect(layerRegistrations().find((r) => r.id === "sun-time-band-0")?.slot).toBe(
      "area-overlays",
    );
  });

  it("publishes sixteen band features into the shared source", () => {
    render(<SunTimeLayer />);

    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    expect(data?.features).toHaveLength(16);
  });

  it("correlates each layer's filter with the matching band index in the published data", () => {
    render(<SunTimeLayer />);

    expect(fake.state.filters.get("sun-time-band-3")).toEqual(["==", ["get", "band"], 3]);

    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    const bandValues = data?.features.map((f) => f.properties?.band).sort((a, b) => a - b);
    expect(bandValues).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it("disables antialiasing so nested rings do not seam", () => {
    render(<SunTimeLayer />);

    expect(fake.state.paint.get("sun-time-band-0")?.["fill-antialias"]).toBe(false);
  });

  it("removes every band layer when the overlay is hidden", () => {
    render(<SunTimeLayer />);
    expect(fake.state.layers.has("sun-time-band-0")).toBe(true);
    expect(fake.state.layers.has("sun-time-band-15")).toBe(true);

    act(() => {
      useSunTimeStore.setState({ layerVisible: false });
    });

    expect(fake.state.layers.has("sun-time-band-0")).toBe(false);
    expect(fake.state.layers.has("sun-time-band-15")).toBe(false);
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
  });

  it("survives a base-map style reload with every band layer and its data intact", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
    useSunTimeStore.setState({ showTimeZones: true });
    render(<SunTimeLayer />);
    // Let the time zone fetch resolve before the swap, so the reload is
    // proven to replay decorated (not just empty) data.
    await vi.waitFor(() => {
      const tzData = fake.state.sources.get(TZ_SOURCE_ID)?.data as
        | GeoJSON.FeatureCollection
        | undefined;
      expect(tzData?.features).toHaveLength(1);
    });

    // The retained payload replays through a bridge-internal microtask (see
    // useGeoJsonSourceDataBridge.test.tsx), which a synchronous act() does not
    // drain — flush it before asserting nothing was lost.
    act(() => {
      fake.map.setStyle({} as never);
    });
    await act(async () => {});

    for (const id of BAND_LAYER_IDS) {
      expect(fake.state.layers.get(id)?.type).toBe("fill");
    }
    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    expect(data?.features).toHaveLength(16);

    for (const id of [TZ_FILL_LAYER_ID, TZ_LINE_LAYER_ID, TZ_LABEL_LAYER_ID]) {
      expect(fake.state.layers.has(id)).toBe(true);
    }
    const tzData = fake.state.sources.get(TZ_SOURCE_ID)?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    expect(tzData?.features).toHaveLength(1);
    // Not vi.unstubAllGlobals(): that would also restore the real `Image`,
    // undoing the module-level StubImage every later test in this file relies
    // on. The top-level afterEach resets showTimeZones (and fetch is only
    // ever touched behind that flag), so nothing further to clean up here.
  });

  it("follows the wall clock, republishes on each tick, and stops after unmount", () => {
    vi.useFakeTimers();
    useSunTimeStore.setState({ timeMs: null });
    const { unmount } = render(<SunTimeLayer />);
    const initialSetDataCount = fake.state.counts.setData.get(SOURCE_ID) ?? 0;

    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    const afterTickCount = fake.state.counts.setData.get(SOURCE_ID) ?? 0;
    expect(afterTickCount).toBeGreaterThan(initialSetDataCount);

    unmount();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(fake.state.counts.setData.get(SOURCE_ID)).toBe(afterTickCount);
  });

  it("keeps the shared clock ticking for the legend even when the layer itself is hidden", () => {
    vi.useFakeTimers();
    useSunTimeStore.setState({
      layerVisible: false,
      showTerminator: false,
      panelOpen: true,
      timeMs: null,
    });
    render(<SunTimeLayer />);
    const initialNowMs = useSunTimeStore.getState().nowMs;

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    // The legend reads this same field; a hidden layer must not freeze it.
    expect(useSunTimeStore.getState().nowMs).toBeGreaterThan(initialNowMs);
  });
});

describe("SunTimeLayer subsolar marker", () => {
  it("adds a subsolar symbol layer capped to world zooms", () => {
    render(<SunTimeLayer />);

    const layer = fake.state.layers.get(SUBSOLAR_LAYER_ID);
    expect(layer?.type).toBe("symbol");
    expect(layer?.maxzoom).toBe(4);
    expect(layerRegistrations().find((r) => r.id === SUBSOLAR_LAYER_ID)?.slot).toBe(
      "overlay-markers",
    );
  });

  it("publishes the subsolar point as a single feature", () => {
    render(<SunTimeLayer />);

    const data = fake.state.sources.get(SUBSOLAR_SOURCE_ID)?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    expect(data?.features).toHaveLength(1);
    expect(data?.features?.[0]?.geometry.type).toBe("Point");
  });

  it("removes the marker layer and source when the overlay is hidden", () => {
    render(<SunTimeLayer />);
    expect(fake.state.layers.has(SUBSOLAR_LAYER_ID)).toBe(true);

    act(() => {
      useSunTimeStore.setState({ layerVisible: false });
    });

    expect(fake.state.layers.has(SUBSOLAR_LAYER_ID)).toBe(false);
    expect(fake.state.sources.has(SUBSOLAR_SOURCE_ID)).toBe(false);
  });

  it("survives a base-map style reload with the marker, its icon, and its data intact", async () => {
    render(<SunTimeLayer />);
    act(() => {
      fake.map.setStyle({} as never);
    });
    await act(async () => {});

    expect(fake.state.layers.get(SUBSOLAR_LAYER_ID)?.type).toBe("symbol");
    expect(fake.state.images.has(SUBSOLAR_IMAGE_ID)).toBe(true);
    const data = fake.state.sources.get(SUBSOLAR_SOURCE_ID)?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    expect(data?.features).toHaveLength(1);
  });

  it("registers the sun icon at 2x pixel ratio so it stays crisp on retina", () => {
    const addImageSpy = vi.spyOn(fake.map, "addImage");
    render(<SunTimeLayer />);

    expect(addImageSpy).toHaveBeenCalledWith(SUBSOLAR_IMAGE_ID, expect.anything(), {
      pixelRatio: 2,
    });
  });
});

describe("SunTimeLayer lifecycle teardown", () => {
  it("removes every band layer, the subsolar marker, the time zone layers, and every source on unmount while still active", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
    useSunTimeStore.setState({ showTimeZones: true });
    const { unmount } = render(<SunTimeLayer />);
    expect(fake.state.layers.has("sun-time-band-0")).toBe(true);
    expect(fake.state.layers.has(SUBSOLAR_LAYER_ID)).toBe(true);
    expect(fake.state.layers.has(TZ_FILL_LAYER_ID)).toBe(true);

    unmount();

    for (const id of BAND_LAYER_IDS) {
      expect(fake.state.layers.has(id)).toBe(false);
    }
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
    expect(fake.state.layers.has(SUBSOLAR_LAYER_ID)).toBe(false);
    expect(fake.state.sources.has(SUBSOLAR_SOURCE_ID)).toBe(false);
    for (const id of [TZ_FILL_LAYER_ID, TZ_LINE_LAYER_ID, TZ_LABEL_LAYER_ID]) {
      expect(fake.state.layers.has(id)).toBe(false);
    }
    expect(fake.state.sources.has(TZ_SOURCE_ID)).toBe(false);
    // Not vi.unstubAllGlobals() — see the same note above. The top-level
    // afterEach resets showTimeZones.
  });

  it("cancels a pending idle sync so hiding the overlay mid-style-load does not resurrect it", () => {
    fake = createFakeMap({ styleLoaded: false });
    mapRefBox.current = fake.map;
    render(<SunTimeLayer />);

    // The style hasn't finished loading, so the first pass only scheduled
    // itself on "idle" instead of adding anything.
    expect(fake.state.layers.has("sun-time-band-0")).toBe(false);

    act(() => {
      useSunTimeStore.setState({ layerVisible: false });
    });

    // The style finishes loading only after the overlay was already hidden.
    fake.state.styleLoaded = true;
    act(() => {
      fake.emit("idle");
    });

    expect(fake.state.layers.has("sun-time-band-0")).toBe(false);
    expect(fake.state.sources.has(SOURCE_ID)).toBe(false);
  });
});

describe("SunTimeLayer time zones", () => {
  beforeEach(() => {
    useSunTimeStore.setState({
      layerVisible: true,
      showTerminator: false,
      showTimeZones: true,
      timeMs: Date.UTC(2026, 6, 15, 12),
    });
  });

  // showTimeZones resets in the top-level afterEach; not vi.unstubAllGlobals()
  // there either, which would restore the real `Image` and undo the
  // module-level StubImage other tests in this file rely on.

  it("caps every time zone layer at zoom 8", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
    render(<SunTimeLayer />);

    await vi.waitFor(() => {
      expect(fake.state.layers.has(TZ_FILL_LAYER_ID)).toBe(true);
    });
    for (const id of [TZ_FILL_LAYER_ID, TZ_LINE_LAYER_ID, TZ_LABEL_LAYER_ID]) {
      expect(fake.state.layers.get(id)?.maxzoom).toBe(8);
    }
  });

  it("decorates each zone with its offset at the selected instant", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
    render(<SunTimeLayer />);

    await vi.waitFor(() => {
      const data = fake.state.sources.get(TZ_SOURCE_ID)?.data as
        | GeoJSON.FeatureCollection
        | undefined;
      expect(data?.features[0]?.properties).toMatchObject({
        tzid: "Europe/Berlin",
        offsetMinutes: 120,
        offsetLabel: "UTC+2",
      });
    });
  });

  it("fetches the boundaries only once across re-renders", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE }));
    vi.stubGlobal("fetch", fetchMock);
    const { rerender } = render(<SunTimeLayer />);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender(<SunTimeLayer />);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A clock tick recomputes the decoration but must not be a fetch dependency.
    act(() => {
      useSunTimeStore.setState({ timeMs: Date.UTC(2026, 0, 15, 12) });
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("skips re-publishing the decorated data across a tick that doesn't cross an offset boundary", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
    render(<SunTimeLayer />);

    await vi.waitFor(() => {
      const data = fake.state.sources.get(TZ_SOURCE_ID)?.data as
        | GeoJSON.FeatureCollection
        | undefined;
      expect(data?.features).toHaveLength(1);
    });
    const setDataCountBefore = fake.state.counts.setData.get(TZ_SOURCE_ID) ?? 0;

    // One minute later, same day — Europe/Berlin stays at UTC+2 throughout, so
    // rebuilding and re-publishing the ~1.3 MB decorated FeatureCollection for
    // this tick would be pure waste.
    act(() => {
      useSunTimeStore.setState({ timeMs: Date.UTC(2026, 6, 15, 12, 1) });
    });

    expect(fake.state.counts.setData.get(TZ_SOURCE_ID) ?? 0).toBe(setDataCountBefore);
  });

  it("drops a zone whose id the platform cannot resolve instead of poisoning the layer", async () => {
    const mixedFixture = {
      type: "FeatureCollection",
      features: [
        ...TZ_FIXTURE.features,
        {
          type: "Feature",
          properties: { tzid: "Mars/Olympus" },
          geometry: {
            type: "Polygon",
            coordinates: [
              [
                [0, 0],
                [1, 0],
                [1, 1],
                [0, 0],
              ],
            ],
          },
        },
      ],
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => mixedFixture })),
    );
    render(<SunTimeLayer />);

    await vi.waitFor(() => {
      const data = fake.state.sources.get(TZ_SOURCE_ID)?.data as
        | GeoJSON.FeatureCollection
        | undefined;
      expect(data?.features).toHaveLength(1);
      expect(data?.features[0]?.properties?.tzid).toBe("Europe/Berlin");
    });
  });
});

describe("SunTimeLayer sub-toggle transitions", () => {
  beforeEach(() => {
    useSunTimeStore.setState({
      layerVisible: true,
      showTerminator: true,
      showTimeZones: true,
      timeMs: Date.UTC(2026, 6, 15, 12),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
  });

  // showTimeZones resets in the top-level afterEach.
  it("keeps the terminator's published data after the time zone sub-toggle turns off", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => {
      const tzData = fake.state.sources.get(TZ_SOURCE_ID)?.data as
        | GeoJSON.FeatureCollection
        | undefined;
      expect(tzData?.features).toHaveLength(1);
    });

    act(() => {
      useSunTimeStore.setState({ showTimeZones: false });
    });
    await act(async () => {});

    const data = fake.state.sources.get(SOURCE_ID)?.data as GeoJSON.FeatureCollection | undefined;
    expect(data?.features).toHaveLength(16);
  });

  it("keeps the time zone tint's published data after the terminator sub-toggle turns off", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => {
      const tzData = fake.state.sources.get(TZ_SOURCE_ID)?.data as
        | GeoJSON.FeatureCollection
        | undefined;
      expect(tzData?.features).toHaveLength(1);
    });

    act(() => {
      useSunTimeStore.setState({ showTerminator: false });
    });
    await act(async () => {});

    const tzData = fake.state.sources.get(TZ_SOURCE_ID)?.data as
      | GeoJSON.FeatureCollection
      | undefined;
    expect(tzData?.features).toHaveLength(1);
  });
});

describe("SunTimeLayer zone popup", () => {
  beforeEach(() => {
    useSunTimeStore.setState({
      layerVisible: true,
      showTerminator: false,
      showTimeZones: true,
      timeMs: Date.UTC(2026, 6, 15, 12),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, json: async () => TZ_FIXTURE })),
    );
  });

  // showTimeZones resets in the top-level afterEach.

  it("registers the zone fill as interactive while time zones are shown", async () => {
    const onSpy = vi.spyOn(fake.map, "on");
    render(<SunTimeLayer />);

    await vi.waitFor(() =>
      expect(onSpy).toHaveBeenCalledWith("click", TZ_FILL_LAYER_ID, expect.any(Function)),
    );
    expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true);
  });

  it("shows the local wall clock and offset label at the scrubbed instant, never the IANA zone id", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true));

    act(() => {
      fake.emit("click", {
        lngLat: { lng: 13.4, lat: 52.5 },
        features: [
          {
            properties: {
              tzid: "Europe/Berlin",
              offsetMinutes: 120,
              offsetLabel: "UTC+2",
              color: "hsl(30, 55%, 55%)",
            },
          },
        ],
      });
    });

    expect(popupInstances).toHaveLength(1);
    // 12:00 UTC on 2026-07-15 is 14:00 in Europe/Berlin (UTC+2, DST).
    expect(popupInstances[0]?.html).toContain("14:00");
    expect(popupInstances[0]?.html).toContain("UTC+2");
    expect(popupInstances[0]?.html).not.toContain("Europe/Berlin");
  });

  it("escapes HTML that reaches the popup", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true));

    act(() => {
      fake.emit("click", {
        lngLat: { lng: 13.4, lat: 52.5 },
        features: [
          {
            properties: {
              tzid: "Europe/Berlin",
              offsetMinutes: 120,
              offsetLabel: "<script>alert(1)</script>",
              color: "hsl(30, 55%, 55%)",
            },
          },
        ],
      });
    });

    expect(popupInstances[0]?.html).not.toContain("<script>");
    expect(popupInstances[0]?.html).toContain("&lt;script&gt;");
  });

  it("shows no popup when the clicked feature carries no tzid", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true));

    act(() => {
      fake.emit("click", {
        lngLat: { lng: 13.4, lat: 52.5 },
        features: [{ properties: {} }],
      });
    });

    expect(popupInstances).toHaveLength(0);
  });

  it("shows no popup rather than an empty clock when the zone id can't be resolved", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true));

    act(() => {
      fake.emit("click", {
        lngLat: { lng: 0, lat: 0 },
        features: [
          {
            properties: {
              tzid: "Not/AZone",
              offsetMinutes: 0,
              offsetLabel: "UTC",
              color: "hsl(0, 55%, 55%)",
            },
          },
        ],
      });
    });

    expect(popupInstances).toHaveLength(0);
  });

  it("shows a pointer cursor over the zone fill and clears it when the pointer leaves", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true));

    fake.setRenderedFeatures(TZ_FILL_LAYER_ID, [{ properties: {} } as never]);
    act(() => {
      fake.emit("mousemove", { point: { x: 0, y: 0 } });
    });
    expect(fake.map.getCanvasContainer().style.cursor).toBe("pointer");

    fake.setRenderedFeatures(TZ_FILL_LAYER_ID, []);
    act(() => {
      fake.emit("mousemove", { point: { x: 0, y: 0 } });
    });
    expect(fake.map.getCanvasContainer().style.cursor).toBe("");
  });

  it("tears down the click handler, the interactive registration and the open popup when the sub-toggle turns off, not just on unmount", async () => {
    render(<SunTimeLayer />);
    await vi.waitFor(() => expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(true));

    act(() => {
      fake.emit("click", {
        lngLat: { lng: 13.4, lat: 52.5 },
        features: [
          {
            properties: {
              tzid: "Europe/Berlin",
              offsetMinutes: 120,
              offsetLabel: "UTC+2",
              color: "hsl(30, 55%, 55%)",
            },
          },
        ],
      });
    });
    expect(popupInstances).toHaveLength(1);
    expect(popupInstances[0]?.removed).toBe(false);

    act(() => {
      useSunTimeStore.setState({ showTimeZones: false });
    });

    expect(INTERACTIVE_LAYER_IDS.has(TZ_FILL_LAYER_ID)).toBe(false);
    expect(popupInstances[0]?.removed).toBe(true);
    // No handler survives to react to a click after the toggle turned off.
    popupInstances.length = 0;
    act(() => {
      fake.emit("click", {
        lngLat: { lng: 13.4, lat: 52.5 },
        features: [
          {
            properties: {
              tzid: "Europe/Berlin",
              offsetMinutes: 120,
              offsetLabel: "UTC+2",
              color: "hsl(30, 55%, 55%)",
            },
          },
        ],
      });
    });
    expect(popupInstances).toHaveLength(0);
  });
});
