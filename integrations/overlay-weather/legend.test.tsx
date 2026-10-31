import type { CurrentWeather } from "@openmapx/core";
import { beforeEach, expect, it, vi } from "vitest";
import { render } from "@/test";
import { WeatherLegend } from "./legend";
import { useWeatherStore } from "./store";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("@/integration-api/components/WeatherIcon", () => ({ WeatherIcon: () => null }));

const BASE: CurrentWeather = {
  temperature: 20,
  weatherCode: 0,
  isDay: true,
  time: "2026-03-10T10:00:00Z",
};

function renderWith(currentWeather: CurrentWeather) {
  useWeatherStore.setState({
    panelOpen: true,
    layerVisible: true,
    loading: false,
    currentWeather,
    currentWeatherContributors: [],
  });
  return render(<WeatherLegend />);
}

beforeEach(() => {
  useWeatherStore.setState({ currentWeather: null });
});

it("shows every reading the provider reported", () => {
  const { container } = renderWith({
    ...BASE,
    feelsLike: 18,
    windSpeed: 14,
    humidity: 60,
    pressure: 1012,
    cloudCover: 40,
  });
  expect(container).toHaveTextContent("feelsLike 18°C");
  expect(container).toHaveTextContent("windSpeed: 14 km/h · humidity: 60%");
  expect(container).toHaveTextContent("pressure: 1012 hPa · cloudCover: 40%");
});

it("omits readings the provider did not report instead of showing zero", () => {
  const { container } = renderWith({ ...BASE, humidity: 60, cloudCover: 40 });
  expect(container).toHaveTextContent("20°C");
  expect(container).not.toHaveTextContent("feelsLike");
  expect(container).not.toHaveTextContent("windSpeed");
  expect(container).not.toHaveTextContent("pressure");
  expect(container).toHaveTextContent("humidity: 60%");
  expect(container).not.toHaveTextContent("· humidity");
  expect(container).toHaveTextContent("cloudCover: 40%");
  expect(container).not.toHaveTextContent("· cloudCover");
});
