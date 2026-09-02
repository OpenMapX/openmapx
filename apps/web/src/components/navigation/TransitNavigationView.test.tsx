import { setNavigationAuthority, useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NAV_LANDSCAPE_PANEL_WIDTH } from "@/lib/layout";
import { getMapObstructionInsets } from "@/lib/mapObstructions";
import { CHANNEL_GLOBAL } from "@/lib/mobile/mobileShellEnvironment";

const calls = { engine: 0, liveRefresh: [] as boolean[], wakeLock: [] as boolean[] };
const mapCtx = { fitBounds: vi.fn() };

vi.mock("@/integration-api/map/MapContext", async () => ({
  ...(await vi.importActual<typeof import("@/integration-api/map/MapContext")>(
    "@/integration-api/map/MapContext",
  )),
  useMapOptional: () => mapCtx,
}));

vi.mock("@/lib/navigation/useTransitNavigationEngine", () => ({
  useTransitNavigationEngine: () => {
    calls.engine += 1;
  },
}));
vi.mock("@/lib/navigation/useTransitLiveRefresh", () => ({
  useTransitLiveRefresh: (active: boolean) => {
    calls.liveRefresh.push(active);
  },
}));
vi.mock("@/lib/useWakeLock", () => ({
  useWakeLock: (enabled: boolean) => {
    calls.wakeLock.push(enabled);
  },
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

const { TransitNavigationView } = await import("./TransitNavigationView");
const { MobileRuntimeProvider } = await import("@/lib/mobile/MobileRuntimeProvider");

const itinerary = {
  duration: 1_800,
  startTime: "2026-06-01T10:00:00Z",
  endTime: "2026-06-01T10:30:00Z",
  transfers: 0,
  walkDistance: 0,
  legs: [
    {
      mode: "rail",
      tripId: "t1",
      startTime: "2026-06-01T10:00:00Z",
      endTime: "2026-06-01T10:30:00Z",
      from: { stopId: "a", name: "A", lat: 50, lng: 8 },
      to: { stopId: "b", name: "B", lat: 50.1, lng: 8.1 },
      intermediateStops: [],
      geometry: {
        coordinates: [
          [8, 50],
          [8.1, 50.1],
        ],
      },
    },
  ],
} as unknown as TripItinerary;

const shellScope = () => ({
  [CHANNEL_GLOBAL]: { nonce: "abc123" },
  addEventListener: () => {},
  removeEventListener: () => {},
  ReactNativeWebView: { postMessage: () => {} },
});

function mount(scope?: unknown) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileRuntimeProvider webBuildId="web-build-1" scope={scope}>
        <TransitNavigationView />
      </MobileRuntimeProvider>
    </QueryClientProvider>,
  );
}

describe("TransitNavigationView runtime ownership", () => {
  beforeEach(() => {
    calls.engine = 0;
    calls.liveRefresh = [];
    calls.wakeLock = [];
    useNavigationStore.setState({
      status: "navigating",
      kind: "transit",
      itinerary,
      transitProgress: null,
    });
  });

  afterEach(() => {
    cleanup();
    setNavigationAuthority("browser");
    useNavigationStore.getState().stopNavigation();
  });

  it("runs the engine, live refresh and wake lock in an ordinary browser", () => {
    mount({});

    expect(calls.engine).toBeGreaterThan(0);
    expect(calls.liveRefresh).toContain(true);
    expect(calls.wakeLock.length).toBeGreaterThan(0);
  });

  it("runs none of them inside the installed shell", () => {
    mount(shellScope());

    // Native holds the rotating refresh token, schedules the alight alert, and
    // owns the wake lock. A second consumer of any of the three is a second
    // answer to "when do I get off".
    expect(calls.engine).toBe(0);
    expect(calls.liveRefresh).toEqual([]);
    expect(calls.wakeLock).toEqual([]);
  });

  it("still renders the trip UI under native authority", () => {
    const view = mount(shellScope());

    // The WebView remains the product UI; only the ownership moved.
    expect(view.container.textContent).not.toBe("");
  });
});

describe("TransitNavigationView overview", () => {
  beforeEach(() => {
    mapCtx.fitBounds.mockClear();
    useNavigationStore.setState({ status: "navigating", kind: "transit", itinerary });
  });
  afterEach(() => {
    cleanup();
    useNavigationStore.getState().stopNavigation();
  });

  it("frames the whole trip north-up and level", () => {
    const view = mount({});
    fireEvent.click(view.getByLabelText("navigation.moreOptions"));
    fireEvent.click(view.getByText("navigation.overview"));

    // A trip overview is read like a map, whatever pose the follow camera was
    // holding — and the framing only straightens and levels when it is asked to.
    expect(mapCtx.fitBounds).toHaveBeenCalledWith(
      [
        [8, 50],
        [8.1, 50.1],
      ],
      64,
      { bearing: 0, pitch: 0 },
    );
  });
});

describe("TransitNavigationView map coverage", () => {
  afterEach(() => {
    cleanup();
    useNavigationStore.getState().stopNavigation();
  });

  // This view stays mounted for the whole session and renders nothing until a
  // trip runs, so registering its column on `status === "arrived"` alone would
  // reserve a column of map on every idle screen.
  it("reserves the chrome column only once a transit trip is on screen", () => {
    mount({});
    expect(getMapObstructionInsets().left).toBe(0);
    cleanup();

    useNavigationStore.setState({ status: "navigating", kind: "transit", itinerary });
    mount({});
    expect(getMapObstructionInsets().left).toBe(NAV_LANDSCAPE_PANEL_WIDTH + 32);
  });

  it("releases the column on arrival, where only the floating card remains", () => {
    useNavigationStore.setState({ status: "navigating", kind: "transit", itinerary });
    mount({});
    expect(getMapObstructionInsets().left).toBe(NAV_LANDSCAPE_PANEL_WIDTH + 32);

    act(() => useNavigationStore.setState({ status: "arrived" }));
    expect(getMapObstructionInsets().left).toBe(0);
  });
});
