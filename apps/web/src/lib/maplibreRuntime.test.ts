import * as maplibre from "maplibre-gl";
import { afterEach, describe, expect, it } from "vitest";
import { configureMapLibreRuntime, loadMapLibreRuntime } from "./maplibreRuntime";

const originalWorkerUrl = maplibre.getWorkerUrl();

afterEach(() => {
  maplibre.setWorkerUrl(originalWorkerUrl);
});

describe("MapLibre runtime", () => {
  it("uses the version-matched same-origin worker instead of the bundler-derived URL", () => {
    maplibre.setWorkerUrl("");

    const configured = configureMapLibreRuntime(maplibre);

    expect(configured).toBe(maplibre);
    expect(maplibre.getWorkerUrl()).toBe(
      `/runtime/maplibre-gl/${maplibre.getVersion()}/maplibre-gl-worker.mjs`,
    );
  });

  it("configures dynamically loaded runtimes before returning them to map constructors", async () => {
    maplibre.setWorkerUrl("");

    const configured = await loadMapLibreRuntime();

    expect(configured.getWorkerUrl()).toBe(
      `/runtime/maplibre-gl/${configured.getVersion()}/maplibre-gl-worker.mjs`,
    );
  });
});
