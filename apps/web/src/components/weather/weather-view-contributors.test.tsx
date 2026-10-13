import { beforeEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap, type FakeMap, render, screen } from "@/test";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
let response = {
  current: {
    weatherCode: 0,
    isDay: true,
    temperature: 20,
    windSpeed: 5,
    humidity: 60,
    pressure: 1000,
    windDirection: 0,
    feelsLike: 20,
  },
  source: "unknown",
  contributors: [
    {
      sourceId: "actual",
      name: "Captured actual supplier",
      url: "https://actual.test",
      attributionText: "Captured required notice",
    },
  ],
};
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useCurrentWeather: () => ({ data: response, isLoading: false }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true }),
}));
vi.mock("@/integration-api/components/WeatherIcon", () => ({ WeatherIcon: () => null }));

import { PlaceWeather } from "@/components/panels/place/PlaceWeather";
import { WeatherWidget } from "./WeatherWidget";

beforeEach(() => {
  fake = createFakeMap();
  useMapAttributionStore.setState({ byLayer: {} });
});
it("place weather credits captured receipts even when the live registry cannot identify the legacy source", () => {
  render(<PlaceWeather lat={51} lng={6} />);
  expect(screen.getByRole("link", { name: "Captured actual supplier" })).toBeVisible();
});
it("desktop widget map credit uses the displayed response snapshot and honors authoritative empty receipts", () => {
  const { rerender } = render(<WeatherWidget />);
  const html = () => Object.values(useMapAttributionStore.getState().byLayer).flat().join(" ");
  expect(html()).toContain("Captured required notice");
  response = { ...response, contributors: [] };
  rerender(<WeatherWidget />);
  expect(html()).toBe("");
});
