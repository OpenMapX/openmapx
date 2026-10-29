import { sanitizeAttributionHtml } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { parseLicensing } from "@openmapx/mobility-core/licensing";
import { beforeEach, expect, it, vi } from "vitest";
import { useMapAttributionStore } from "@/integration-api/overlay/mapAttributionStore";
import { createFakeMap, type FakeMap, render, screen } from "@/test";
import brightSkyManifest from "../../../../../integrations/weather-bright-sky/manifest.json";

let fake: FakeMap;
const MAP_REF = {
  get current() {
    return fake.map;
  },
};
let response: {
  current: {
    weatherCode: number;
    isDay: boolean;
    temperature: number;
    windSpeed: number;
    humidity: number;
    pressure: number;
    windDirection: number;
    feelsLike: number;
  };
  source: string;
  contributors: Attribution[];
} = {
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
  response = {
    ...response,
    contributors: [
      {
        sourceId: "actual",
        name: "Captured actual supplier",
        url: "https://actual.test",
        attributionText: "Captured required notice",
      },
    ],
  };
});
it("reconstructed contributor HTML produces only safe DOM tags and attributes", () => {
  const element = document.createElement("div");
  element.innerHTML = sanitizeAttributionHtml(
    '<svg onload="bad()"><a href="java&#x73;cript:bad()">unsafe</a></svg><a href="https://actual.test/?name=&quot; onmouseover=&quot;bad()" onclick="bad()"><code>&lt;img src=x onerror=bad()&gt;</code></a>',
  );
  expect(element.querySelector("script, svg, img, [onclick], [onload], [onmouseover]")).toBeNull();
  expect(element.querySelector("a")?.getAttribute("href")).toBe(
    'https://actual.test/?name=" onmouseover="bad()',
  );
  expect(element.querySelector("a")?.getAttribute("rel")).toBe("noopener noreferrer");
  expect(element.textContent).toBe("unsafe<img src=x onerror=bad()>");
});
it("widget tooltip shows the complete decoded notice with quoted greater-than attributes", () => {
  response.contributors[0].attributionText =
    '<a title="A > B" href="https://actual.test">A &amp; B &copy; data</a> (CC BY 4.0)';
  render(<WeatherWidget />);
  expect(screen.getByLabelText("A & B © data (CC BY 4.0)")).toBeVisible();
});
it("place weather credits captured receipts even when the live registry cannot identify the legacy source", () => {
  render(<PlaceWeather lat={51} lng={6} />);
  expect(screen.getByRole("link", { name: "Captured required notice" })).toBeVisible();
});
it("desktop widget map credit uses the displayed response snapshot and honors authoritative empty receipts", () => {
  const { rerender } = render(<WeatherWidget />);
  const html = () =>
    Object.values(useMapAttributionStore.getState().byLayer)
      .flat()
      .map((entry) => entry.fullHtml)
      .join(" ");
  expect(html()).toContain("Captured required notice");
  response = { ...response, contributors: [] };
  rerender(<WeatherWidget />);
  expect(html()).toBe("");
});

it("keeps the Bright Sky hover hint concise while retaining complete map credit details", () => {
  const source = brightSkyManifest.dataSources[0];
  const contributor: Attribution = {
    sourceId: source.sourceId,
    name: source.name,
    url: source.url,
    attributionText: source.attribution,
    licensing: parseLicensing(source.licensing),
  };
  response = { ...response, source: source.sourceId, contributors: [contributor] };
  render(<WeatherWidget />);
  expect(screen.getByLabelText("DWD via Bright Sky")).toBeVisible();
  const presentations = Object.values(useMapAttributionStore.getState().byLayer).flat();
  expect(presentations).toHaveLength(1);
  expect(presentations[0].fullHtml).toContain("Bright Sky access/passed-through DWD policy terms");
  expect(presentations[0].detail?.licensing).toEqual(source.licensing);
});

it("uses the captured provider name when no explicit credit is supplied", () => {
  response = {
    ...response,
    contributors: [{ sourceId: "actual", name: "Captured actual supplier" }],
  };
  render(<WeatherWidget />);
  expect(screen.getByLabelText("Captured actual supplier")).toBeVisible();
});
