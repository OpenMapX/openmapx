import type { CurrentWeather } from "@openmapx/core";
import { beforeEach, expect, it, vi } from "vitest";
import { createFakeMap, type FakeMap, render, screen } from "@/test";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
const FULL: CurrentWeather = {
  temperature: 20,
  feelsLike: 18,
  humidity: 60,
  pressure: 1012,
  windSpeed: 14,
  windDirection: 90,
  precipitation: 0,
  cloudCover: 40,
  weatherCode: 0,
  isDay: true,
  time: "2026-03-10T10:00:00Z",
};
const SPARSE: CurrentWeather = {
  temperature: 20,
  weatherCode: 0,
  isDay: true,
  time: "2026-03-10T10:00:00Z",
};
let current: CurrentWeather = FULL;

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useCurrentWeather: () => ({
    data: { current, source: "bright-sky", contributors: [] },
    isLoading: false,
  }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: MAP_REF, mapReady: true }),
}));
vi.mock("@/integration-api/components/WeatherIcon", () => ({ WeatherIcon: () => null }));

import { PlaceWeather } from "@/components/panels/place/PlaceWeather";
import { WeatherWidget } from "./WeatherWidget";

beforeEach(() => {
  fake = createFakeMap();
  current = FULL;
});

it("place weather shows each reported reading", () => {
  const { container } = render(<PlaceWeather lat={51} lng={6} />);
  expect(container).toHaveTextContent("feelsLike 18°C");
  expect(container).toHaveTextContent("windSpeed: 14 km/h E");
  expect(container).toHaveTextContent("humidity: 60%");
  expect(container).toHaveTextContent("pressure: 1012 hPa");
});

it("place weather omits readings the provider did not report", () => {
  current = SPARSE;
  const { container: sparse } = render(<PlaceWeather lat={51} lng={6} />);
  for (const label of ["feelsLike", "windSpeed", "humidity", "pressure"]) {
    expect(sparse).not.toHaveTextContent(label);
  }
  expect(sparse).toHaveTextContent("20°C");
});

it("widget shows only the humidity and wind it has", () => {
  render(<WeatherWidget />);
  expect(screen.getByText(/H:60% W:14km\/h E/)).toBeInTheDocument();
});

it("widget omits humidity and wind the provider did not report", () => {
  current = { ...SPARSE, windSpeed: 9, windDirection: 180 };
  const { container, unmount } = render(<WeatherWidget />);
  expect(container).not.toHaveTextContent("H:");
  expect(container).toHaveTextContent("W:9km/h S");
  unmount();

  current = SPARSE;
  const { container: sparse } = render(<WeatherWidget />);
  expect(sparse).not.toHaveTextContent("H:");
  expect(sparse).not.toHaveTextContent("W:");
  expect(sparse).toHaveTextContent("20°C");
});
