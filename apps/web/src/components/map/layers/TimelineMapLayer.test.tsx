import type { PersonalTimelineDayV1, TimelineConnectionView } from "@openmapx/core";
import { PANEL, usePersonalTimelineStore, useSidebarStore } from "@openmapx/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, createFakeMap, expectStyleSwapIsLossless, type FakeMap, render } from "@/test";

let fake: FakeMap;
const fitBounds = vi.fn();
const dayHook = vi.fn();
const connectionHook = vi.fn();

const session = { current: { data: { user: { id: "user-a" } }, isPending: false } };
const connection: TimelineConnectionView = {
  connected: true,
  connection: {
    mode: "external",
    publicOrigin: "https://dawarich.example.test",
    displayName: "Dawarich",
    upstreamEmail: null,
    timeZone: "Europe/Berlin",
    distanceUnit: "km",
    status: "connected",
    validatedAt: "2026-08-09T10:00:00.000Z",
    lastReadAt: null,
  },
  managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
};

function day(date = "2026-08-09", bounds: PersonalTimelineDayV1["bounds"] = [13, 52, 14, 53]) {
  return {
    version: 1,
    date,
    timeZone: "Europe/Berlin",
    distanceUnit: "km",
    summary: { totalDistance: 2, placesVisited: 1, movingMinutes: 20, stationaryMinutes: 30 },
    bounds,
    entries: [],
    map: {
      tracks: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: "journey-1" },
            geometry: {
              type: "LineString",
              coordinates: [
                [13.2, 52.4],
                [13.5, 52.6],
              ],
            },
          },
        ],
      },
      visits: {
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: "visit-1" },
            geometry: { type: "Point", coordinates: [13.4, 52.5] },
          },
        ],
      },
    },
    capabilities: { trackGeometry: true, elevation: false },
    warnings: [],
  } satisfies PersonalTimelineDayV1;
}

const queryState = {
  connection: { data: connection },
  day: { data: day(), isSuccess: true },
};

vi.mock("@openmapx/core", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@openmapx/core")>();
  return {
    ...actual,
    useSession: () => session.current,
    useTimelineConnection: (...args: unknown[]) => {
      connectionHook(...args);
      return queryState.connection;
    },
    usePersonalTimelineDay: (...args: unknown[]) => {
      dayHook(...args);
      return queryState.day;
    },
  };
});

vi.mock("@/lib/MapContext", () => ({
  useMap: () => ({
    mapRef: { current: fake.map },
    mapReady: true,
    styleVersion: 0,
    fitBounds,
  }),
}));

import {
  buildTimelineLayerGroup,
  PERSONAL_TIMELINE_TRACKS_LAYER_ID,
  PERSONAL_TIMELINE_TRACKS_SOURCE_ID,
  PERSONAL_TIMELINE_VISITS_LAYER_ID,
  PERSONAL_TIMELINE_VISITS_SOURCE_ID,
  TimelineMapLayer,
} from "./TimelineMapLayer";

function openTimeline(date = "2026-08-09") {
  usePersonalTimelineStore.getState().setSelectedDate(date);
  useSidebarStore.getState().openSidebar(PANEL.TIMELINE);
}

beforeEach(() => {
  fake = createFakeMap({ baseLayers: [{ id: "place-labels", type: "symbol" }] });
  fitBounds.mockClear();
  dayHook.mockClear();
  connectionHook.mockClear();
  session.current = { data: { user: { id: "user-a" } }, isPending: false };
  queryState.connection = { data: connection };
  queryState.day = { data: day(), isSuccess: true };
  usePersonalTimelineStore.getState().resetForSession();
  useSidebarStore.getState().closeAll();
});

describe("TimelineMapLayer", () => {
  it("does not query or register resources while the timeline panel is inactive", () => {
    render(<TimelineMapLayer />);

    expect(connectionHook).not.toHaveBeenCalled();
    expect(dayHook).not.toHaveBeenCalled();
    expect(fake.state.sources.size).toBe(0);
  });

  it("builds one normalized group with stable sources, layer slots and selection expressions", () => {
    const group = buildTimelineLayerGroup(day(), "journey-1");

    expect(Object.keys(group.sources)).toEqual([
      PERSONAL_TIMELINE_TRACKS_SOURCE_ID,
      PERSONAL_TIMELINE_VISITS_SOURCE_ID,
    ]);
    expect(group.layers.map(({ id, slot }) => [id, slot])).toEqual([
      [PERSONAL_TIMELINE_TRACKS_LAYER_ID, "overlay-lines"],
      [PERSONAL_TIMELINE_VISITS_LAYER_ID, "overlay-points"],
    ]);
    expect((group.layers[0] as { paint: Record<string, unknown> }).paint).toMatchObject({
      "line-width": ["case", ["==", ["get", "id"], "journey-1"], 6, 3],
    });
    expect((group.layers[1] as { paint: Record<string, unknown> }).paint).toMatchObject({
      "circle-radius": ["case", ["==", ["get", "id"], "journey-1"], 10, 6],
    });
  });

  it("queries the owner/date and draws both normalized sources while active", () => {
    openTimeline();
    render(<TimelineMapLayer />);

    expect(connectionHook).toHaveBeenCalledWith("user-a");
    expect(dayHook).toHaveBeenCalledWith("user-a", "2026-08-09", true);
    expect(fake.state.sources.get(PERSONAL_TIMELINE_TRACKS_SOURCE_ID)?.data).toEqual(
      queryState.day.data.map.tracks,
    );
    expect(fake.state.sources.get(PERSONAL_TIMELINE_VISITS_SOURCE_ID)?.data).toEqual(
      queryState.day.data.map.visits,
    );
    expect(fake.state.layers.has(PERSONAL_TIMELINE_TRACKS_LAYER_ID)).toBe(true);
    expect(fake.state.layers.has(PERSONAL_TIMELINE_VISITS_LAYER_ID)).toBe(true);
  });

  it("does not call the day hook until an active readable connection exists", () => {
    queryState.connection = {
      data: {
        connected: false,
        connection: null,
        managed: { available: false, healthy: false, publicOrigin: null, reason: "disabled" },
      },
    };
    openTimeline();
    render(<TimelineMapLayer />);

    expect(connectionHook).toHaveBeenCalledWith("user-a");
    expect(dayHook).not.toHaveBeenCalled();
    expect(fake.state.sources.size).toBe(0);
  });

  it("fits each successful date once and does not refit for entry selection or rerenders", () => {
    openTimeline();
    const view = render(<TimelineMapLayer />);

    expect(fitBounds).toHaveBeenCalledTimes(1);
    expect(fitBounds).toHaveBeenLastCalledWith(
      [
        [13, 52],
        [14, 53],
      ],
      80,
    );

    act(() => usePersonalTimelineStore.getState().selectEntry("journey-1"));
    view.rerender(<TimelineMapLayer />);
    expect(fitBounds).toHaveBeenCalledTimes(1);

    queryState.day = { data: day("2026-08-08", [10, 40, 12, 42]), isSuccess: true };
    act(() => usePersonalTimelineStore.getState().setSelectedDate("2026-08-08"));
    expect(fitBounds).toHaveBeenCalledTimes(2);
  });

  it("selects an entry only from timeline layer clicks and synchronizes pointer feedback", () => {
    openTimeline();
    const on = vi.spyOn(fake.map, "on");
    render(<TimelineMapLayer />);

    expect(on).toHaveBeenCalledWith(
      "click",
      PERSONAL_TIMELINE_TRACKS_LAYER_ID,
      expect.any(Function),
    );
    expect(on).toHaveBeenCalledWith(
      "click",
      PERSONAL_TIMELINE_VISITS_LAYER_ID,
      expect.any(Function),
    );
    act(() => fake.emit("click", { features: [{ properties: { id: "visit-1" } }] }));
    expect(usePersonalTimelineStore.getState().selectedEntryId).toBe("visit-1");

    act(() => fake.emit("mouseenter"));
    expect(fake.map.getCanvas().style.cursor).toBe("pointer");
    act(() => fake.emit("mouseleave"));
    expect(fake.map.getCanvas().style.cursor).toBe("");
  });

  it("reconciles both sources and selected styling across a style reload", () => {
    openTimeline();
    act(() => usePersonalTimelineStore.getState().selectEntry("visit-1"));
    render(<TimelineMapLayer />);

    expectStyleSwapIsLossless(fake);
    expect(fake.state.sources.get(PERSONAL_TIMELINE_VISITS_SOURCE_ID)?.data).toEqual(
      queryState.day.data.map.visits,
    );
    expect(fake.state.paint.get(PERSONAL_TIMELINE_VISITS_LAYER_ID)?.["circle-radius"]).toEqual([
      "case",
      ["==", ["get", "id"], "visit-1"],
      10,
      6,
    ]);
  });

  it("removes all sources, layers, handlers, cursor and selection when the panel closes", () => {
    openTimeline();
    act(() => usePersonalTimelineStore.getState().selectEntry("visit-1"));
    const off = vi.spyOn(fake.map, "off");
    render(<TimelineMapLayer />);
    act(() => fake.emit("mouseenter"));

    act(() => useSidebarStore.getState().closeAll());

    expect(fake.state.sources.has(PERSONAL_TIMELINE_TRACKS_SOURCE_ID)).toBe(false);
    expect(fake.state.sources.has(PERSONAL_TIMELINE_VISITS_SOURCE_ID)).toBe(false);
    expect(fake.state.layers.has(PERSONAL_TIMELINE_TRACKS_LAYER_ID)).toBe(false);
    expect(fake.state.layers.has(PERSONAL_TIMELINE_VISITS_LAYER_ID)).toBe(false);
    expect(fake.map.getCanvas().style.cursor).toBe("");
    expect(usePersonalTimelineStore.getState().selectedEntryId).toBeNull();
    expect(off).toHaveBeenCalledWith(
      "click",
      PERSONAL_TIMELINE_TRACKS_LAYER_ID,
      expect.any(Function),
    );
    expect(off).toHaveBeenCalledWith(
      "click",
      PERSONAL_TIMELINE_VISITS_LAYER_ID,
      expect.any(Function),
    );
    expect(fake.state.handlers.get("click")?.size ?? 0).toBe(0);
  });
});
