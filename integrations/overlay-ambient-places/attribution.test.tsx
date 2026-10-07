import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { useIntegrationAttribution } from "@/integration-api/overlay/useIntegrationAttribution";
import manifest from "./manifest.json";

vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ get: () => manifest }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: false }),
}));
afterEach(() => {
  cleanup();
  useMapAttributionStore.setState({ byLayer: {} });
});
it("credits ambient OSM data independently of basemap credits", () => {
  const view = renderHook(
    ({ active }) => useIntegrationAttribution("overlay-ambient-places", active),
    { initialProps: { active: true } },
  );
  const credits = useMapAttributionStore
    .getState()
    .byLayer["integration:overlay-ambient-places"].join(" ");
  expect(credits).toContain("OpenStreetMap contributors");
  expect(credits).toContain("https://www.openstreetmap.org/copyright");
  view.rerender({ active: false });
  expect(
    useMapAttributionStore.getState().byLayer["integration:overlay-ambient-places"],
  ).toBeUndefined();
});
