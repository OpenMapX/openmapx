import { setNavigationAuthority, useNavigationStore } from "@openmapx/core";
import type { TripItinerary } from "@openmapx/mobility-core/transit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNEL_GLOBAL } from "@/lib/mobile/mobileShellEnvironment";

const calls = { engine: 0, liveRefresh: [] as boolean[], wakeLock: [] as boolean[] };

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
