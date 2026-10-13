import { expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
let response = {
  current: { weatherCode: 0, isDay: true, temperature: 20 },
  source: "unknown",
  contributors: [{ sourceId: "actual", name: "Actual supplier", url: "https://actual.test" }],
};
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useCurrentWeather: () => ({ data: response }),
}));
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({ time: () => "12:00" }),
}));
vi.mock("@/integration-api/components/WeatherIcon", () => ({ WeatherIcon: () => null }));

import { PlaceHeaderWeather } from "./PlaceHeaderWeather";

it("visibly credits the compact city weather response on mobile and keeps authoritative empty receipts", () => {
  const { rerender } = render(<PlaceHeaderWeather lat={51} lng={6} />);
  expect(screen.getByRole("link", { name: "Actual supplier" })).toBeVisible();
  response = { ...response, contributors: [] };
  rerender(<PlaceHeaderWeather lat={51} lng={6} />);
  expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
});
