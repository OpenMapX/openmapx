import { afterEach, expect, it, vi } from "vitest";
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
  useDateTimeFormat: () => ({
    time: (date: Date, options: Intl.DateTimeFormatOptions) => {
      // Exercise the same unsupported-zone failure as the real formatter.
      new Intl.DateTimeFormat("en-GB", options).format(date);
      return "12:00";
    },
  }),
}));
vi.mock("@/integration-api/components/WeatherIcon", () => ({ WeatherIcon: () => null }));

import { PlaceHeaderWeather } from "./PlaceHeaderWeather";

afterEach(() => vi.restoreAllMocks());

it("keeps weather and its credit when the browser cannot format the looked-up zone", () => {
  const RealDateTimeFormat = Intl.DateTimeFormat;
  vi.spyOn(Intl, "DateTimeFormat").mockImplementation((locale, options) => {
    if (options?.timeZone === "America/Coyhaique") {
      throw new RangeError("Unknown time zone America/Coyhaique");
    }
    return new RealDateTimeFormat(locale, options);
  });

  render(<PlaceHeaderWeather lat={-45.5752} lng={-72.0662} />);
  expect(screen.getByText(/20°C/)).toBeVisible();
  expect(screen.getByRole("link", { name: "Actual supplier" })).toBeVisible();
  expect(screen.queryByText("12:00")).not.toBeInTheDocument();
});

it("visibly credits the compact city weather response on mobile and keeps authoritative empty receipts", () => {
  const { rerender } = render(<PlaceHeaderWeather lat={51} lng={6} />);
  expect(screen.getByRole("link", { name: "Actual supplier" })).toBeVisible();
  response = { ...response, contributors: [] };
  rerender(<PlaceHeaderWeather lat={51} lng={6} />);
  expect(screen.queryByRole("contentinfo")).not.toBeInTheDocument();
});
