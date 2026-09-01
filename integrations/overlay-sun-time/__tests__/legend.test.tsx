import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, type FakeMap, fireEvent, render, screen } from "@/test";
import { useSunTimeStore } from "../store";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

let fake: FakeMap;

vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
  }),
}));

vi.mock("@/integration-api/runtime/EnvProvider", () => ({
  useEnv: () => ({ apiUrl: "http://api.test" }),
}));

// jsdom never decodes images, so a real `Image.onload` would never fire and the
// map layer's icon-load path would hang forever under test. Stub the global so
// setting `.src` resolves the load synchronously — copied from map-layer.test.tsx
// because the shared-clock tests below mount SunTimeLayer alongside the legend.
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

// `t(key)` under the mock returns "sunTime.<key>", so the assertions below
// read against stable keys rather than copies of the message catalog.
import SunTimeLegend, { BAND_STOPS } from "../legend";
import SunTimeLayer from "../map-layer";

describe("BAND_STOPS", () => {
  it("matches the accumulated alpha the map layer actually paints at each boundary", () => {
    // 1 - (1 - BAND_OPACITY) ** k for k stacked fills, rounded to 2dp — not the
    // stale hand-picked values (0.18/0.36) the strip used to hardcode.
    expect(BAND_STOPS.find((s) => s.key === "day")?.color).toBe("rgba(11, 16, 38, 0)");
    expect(BAND_STOPS.find((s) => s.key === "civil")?.color).toBe("rgba(11, 16, 38, 0.26)");
    expect(BAND_STOPS.find((s) => s.key === "nautical")?.color).toBe("rgba(11, 16, 38, 0.42)");
    expect(BAND_STOPS.find((s) => s.key === "night")?.color).toBe("rgba(11, 16, 38, 0.55)");
  });
});

describe("SunTimeLegend", () => {
  beforeEach(() => {
    fake = createFakeMap();
    useSunTimeStore.setState({
      panelOpen: true,
      layerVisible: true,
      showTerminator: true,
      showTimeZones: false,
      timeMs: null,
      nowMs: Date.now(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing when the panel is closed", () => {
    useSunTimeStore.setState({ panelOpen: false });
    const { container } = render(<SunTimeLegend />);
    expect(container).toBeEmptyDOMElement();
  });

  it("pins the instant when the time slider moves", () => {
    render(<SunTimeLegend />);
    fireEvent.change(screen.getByLabelText("sunTime.time"), { target: { value: "540" } });
    expect(useSunTimeStore.getState().timeMs).not.toBeNull();
  });

  it("returns to the wall clock when Now is pressed", () => {
    useSunTimeStore.setState({ timeMs: 1_800_000_000_000 });
    render(<SunTimeLegend />);
    fireEvent.click(screen.getByRole("button", { name: "sunTime.now" }));
    expect(useSunTimeStore.getState().timeMs).toBeNull();
  });

  it("toggles the time zone sub-layer", () => {
    render(<SunTimeLegend />);
    fireEvent.click(screen.getByLabelText("sunTime.timeZones"));
    expect(useSunTimeStore.getState().showTimeZones).toBe(true);
  });

  it("shows the zoom hint only while the time zone sub-toggle is on", () => {
    render(<SunTimeLegend />);
    expect(screen.queryByText("sunTime.timeZonesZoomHint")).toBeNull();

    fireEvent.click(screen.getByLabelText("sunTime.timeZones"));
    expect(screen.getByText("sunTime.timeZonesZoomHint")).toBeTruthy();
  });

  it("reflects a pinned instant in the date field and the time slider", () => {
    // 23:57 local — past the old 1430-minute slider max, so a regression back
    // to that ceiling would clamp this value and fail the assertion below.
    const pinned = new Date(2024, 2, 15, 23, 57, 0, 0).getTime();
    useSunTimeStore.setState({ timeMs: pinned });
    render(<SunTimeLegend />);

    expect(screen.getByLabelText("sunTime.date")).toHaveValue("2024-03-15");
    expect(screen.getByLabelText("sunTime.time")).toHaveValue(String(23 * 60 + 57));
    expect(screen.getByLabelText("sunTime.time")).toHaveAttribute("max", "1439");
  });

  it("renders the four twilight-band labels", () => {
    render(<SunTimeLegend />);
    for (const key of ["day", "civil", "nautical", "night"]) {
      expect(screen.getByText(`sunTime.${key}`)).toBeTruthy();
    }
  });

  it("advances the displayed time once a minute from the same clock the map layer ticks, even with the layer itself hidden", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2024, 2, 15, 9, 0, 0, 0));
    // Layer hidden + terminator off: only the open panel keeps the shared
    // clock alive. Rendering the legend alone (no SunTimeLayer) would leave
    // `nowMs` frozen at the value seeded in beforeEach — this is the
    // regression guard for the legend having previously called Date.now() at
    // render time instead of reading the map layer's shared tick.
    useSunTimeStore.setState({
      layerVisible: false,
      showTerminator: false,
      panelOpen: true,
      timeMs: null,
    });

    render(
      <>
        <SunTimeLayer />
        <SunTimeLegend />
      </>,
    );

    expect(screen.getByText("sunTime.time: 09:00")).toBeTruthy();

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(screen.getByText("sunTime.time: 09:01")).toBeTruthy();
  });
});
