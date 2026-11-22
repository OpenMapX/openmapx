import { type Route, useNavigationStore, useSettingsStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@/test";

const runtime = vi.hoisted(() => ({
  browserAuthority: false,
  state: "native-compatible",
  commands: { start: vi.fn(async () => undefined) },
}));

vi.mock("./MobileRuntimeProvider", () => ({
  useMobileRuntimeContext: () => runtime,
}));

import { useStartNavigation } from "./useStartNavigation";

const route = {
  distance: 1_000,
  duration: 120,
  geometry: [
    [8.68, 50.11],
    [8.69, 50.12],
    [8.7, 50.13],
  ],
  steps: [],
  legs: [],
  mode: "driving",
} as unknown as Route;

describe("useStartNavigation.startGround under native authority", () => {
  const initialTiming = useSettingsStore.getState().voiceGuidanceTiming;
  afterEach(() => {
    useSettingsStore.getState().setVoiceGuidanceTiming(initialTiming);
    runtime.commands.start.mockClear();
  });

  it("starts the native session with the user's voice timing", async () => {
    useSettingsStore.getState().setVoiceGuidanceTiming("late");
    const { result } = renderHook(() => useStartNavigation());

    await act(() =>
      result.current.startGround({
        route,
        mode: "driving",
        destinationWaypoints: [[8.7, 50.13]],
        routeSelectionIntent: "automatic",
        routeOptions: {} as never,
        locale: "en",
        units: "metric",
      }),
    );

    expect(runtime.commands.start).toHaveBeenCalledWith(
      expect.objectContaining({
        settings: expect.objectContaining({ voiceTiming: "late" }),
      }),
      undefined,
    );
  });

  describe("voice references", () => {
    afterEach(() => useNavigationStore.getState().stopNavigation());

    const start = async (forRoute: Route) => {
      const { result } = renderHook(() => useStartNavigation());
      await act(() =>
        result.current.startGround({
          route: forRoute,
          mode: "driving",
          destinationWaypoints: [[8.7, 50.13]],
          routeSelectionIntent: "automatic",
          routeOptions: {} as never,
          locale: "en",
          units: "metric",
        }),
      );
      return runtime.commands.start.mock.calls.at(-1)?.[0 as never] as unknown as Record<
        string,
        unknown
      >;
    };

    it("hands the store's references for this route to the native session", async () => {
      useNavigationStore.setState({
        route,
        signalsAlong: [120],
        signalSpans: [{ from: 0, to: 1_000 }],
        landmarkReferences: {
          route,
          byStep: { 2: { stepIndex: 2, category: "fuel", brand: "Aral" } },
        },
      });
      const startPackage = await start(route);
      expect(startPackage.signalsAlong).toEqual([120]);
      expect(startPackage.signalSpans).toEqual([{ from: 0, to: 1_000 }]);
      expect(startPackage.landmarkReferences).toEqual([
        { stepIndex: 2, category: "fuel", brand: "Aral" },
      ]);
    });

    it("hands nothing over for another route", async () => {
      useNavigationStore.setState({
        route,
        signalsAlong: [120],
        signalSpans: [{ from: 0, to: 1_000 }],
        landmarkReferences: { route, byStep: { 2: { stepIndex: 2, category: "fuel" } } },
      });
      const startPackage = await start({ ...route });
      expect(startPackage).not.toHaveProperty("signalsAlong");
      expect(startPackage).not.toHaveProperty("landmarkReferences");
    });

    it("drops signal evidence beyond the package bounds rather than failing the start", async () => {
      useNavigationStore.setState({
        route,
        signalsAlong: Array.from({ length: 2_001 }, (_, i) => i),
        signalSpans: [{ from: 0, to: 1_000 }],
      });
      const startPackage = await start(route);
      expect(startPackage.kind).toBe("ground");
      expect(startPackage).not.toHaveProperty("signalsAlong");
      expect(startPackage).not.toHaveProperty("signalSpans");
    });
  });
});
