// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/EnvProvider", () => {
  const env = { styleProvider: "openmapx" };
  return { useEnv: () => env };
});

vi.mock("@/lib/map", () => ({
  baseMapCreditsHtml: () => [],
  loadMaptilerStyle: vi.fn().mockResolvedValue({}),
  loadOpenMapXStyle: vi.fn().mockResolvedValue({}),
}));

vi.mock("@/components/map/MapCredits", () => ({
  MapCredits: () => null,
}));

vi.mock("maplibre-gl", () => {
  let workerUrl = "";
  class FakeMap {
    static instances: FakeMap[] = [];
    static workerUrlsAtConstruction: string[] = [];

    remove = vi.fn();
    touchZoomRotate = { disableRotation: vi.fn() };
    keyboard = { disableRotation: vi.fn() };
    private readonly handlers = new Map<string, () => void>();

    constructor() {
      FakeMap.instances.push(this);
      FakeMap.workerUrlsAtConstruction.push(workerUrl);
    }

    on = vi.fn((event: unknown, handler: unknown) => {
      if (typeof event === "string" && typeof handler === "function") {
        this.handlers.set(event, handler as () => void);
      }
      return this;
    });

    trigger(event: string): void {
      this.handlers.get(event)?.();
    }

    getBounds() {
      return {
        getWest: () => 1,
        getSouth: () => 2,
        getEast: () => 3,
        getNorth: () => 4,
      };
    }

    getZoom(): number {
      return 5;
    }
  }

  return {
    getVersion: () => "6.1.0",
    getWorkerUrl: () => workerUrl,
    Map: FakeMap,
    setWorkerUrl: (url: string) => {
      workerUrl = url;
    },
  };
});

import * as maplibregl from "maplibre-gl";
import { AreaPickerMap } from "./AreaPickerMap";

const fakeMapClass = maplibregl.Map as unknown as {
  instances: Array<{
    remove: ReturnType<typeof vi.fn>;
    trigger: (event: string) => void;
  }>;
  workerUrlsAtConstruction: string[];
};

afterEach(() => {
  fakeMapClass.instances.length = 0;
  fakeMapClass.workerUrlsAtConstruction.length = 0;
});

describe("AreaPickerMap", () => {
  it("keeps the map mounted when the change callback identity changes", async () => {
    const firstOnChange = vi.fn();
    const latestOnChange = vi.fn();
    const { rerender } = render(
      <AreaPickerMap initialCenter={[10.45, 51.16]} initialZoom={4} onChange={firstOnChange} />,
    );

    await waitFor(() => expect(fakeMapClass.instances).toHaveLength(1));
    expect(fakeMapClass.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);

    rerender(
      <AreaPickerMap initialCenter={[10.45, 51.16]} initialZoom={4} onChange={latestOnChange} />,
    );

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fakeMapClass.instances).toHaveLength(1);
    expect(fakeMapClass.instances[0]?.remove).not.toHaveBeenCalled();

    fakeMapClass.instances[0]?.trigger("moveend");
    expect(firstOnChange).not.toHaveBeenCalled();
    expect(latestOnChange).toHaveBeenCalledWith({ west: 1, south: 2, east: 3, north: 4 }, 5);
  });
});
