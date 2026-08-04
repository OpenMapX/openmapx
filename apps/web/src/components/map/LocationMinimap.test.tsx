// @vitest-environment jsdom

import { render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@mui/material/styles", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@mui/material/styles")>()),
  useColorScheme: () => ({ mode: "light", systemMode: "light" }),
}));

vi.mock("@/lib/EnvProvider", () => ({
  useEnv: () => ({ styleProvider: "openmapx" }),
}));

vi.mock("@/lib/map", () => ({
  baseMapCreditsHtml: () => [],
  loadMaptilerStyle: vi.fn().mockResolvedValue({}),
  loadOpenMapXStyle: vi.fn().mockResolvedValue({}),
}));

vi.mock("./MapCredits", () => ({ MapCredits: () => null }));

vi.mock("maplibre-gl", () => {
  let workerUrl = "";
  const workerUrlsAtConstruction: string[] = [];
  class FakeMap {
    flyTo = vi.fn();
    remove = vi.fn();

    constructor() {
      workerUrlsAtConstruction.push(workerUrl);
    }
  }
  class FakeMarker {
    addTo = vi.fn(() => this);
    setLngLat = vi.fn(() => this);
  }
  return {
    __test: { workerUrlsAtConstruction },
    getVersion: () => "6.1.0",
    getWorkerUrl: () => workerUrl,
    Map: FakeMap,
    Marker: FakeMarker,
    setWorkerUrl: (url: string) => {
      workerUrl = url;
    },
  };
});

import * as maplibregl from "maplibre-gl";
import { LocationMinimap } from "./LocationMinimap";

const maplibreTest = (maplibregl as unknown as { __test: { workerUrlsAtConstruction: string[] } })
  .__test;

afterEach(() => {
  maplibreTest.workerUrlsAtConstruction.length = 0;
});

describe("LocationMinimap", () => {
  it("configures the versioned worker before constructing its map", async () => {
    render(<LocationMinimap lng={6.084959} lat={50.780558} />);

    await waitFor(() => expect(maplibreTest.workerUrlsAtConstruction).toHaveLength(1));
    expect(maplibreTest.workerUrlsAtConstruction).toEqual([
      "/runtime/maplibre-gl/6.1.0/maplibre-gl-worker.mjs",
    ]);
  });
});
