import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next-intl", () => ({
  useTranslations: () => (k: string) => k,
  useLocale: () => "en",
}));
vi.mock("@openmapx/core", () => ({
  formatDistance: (m: number) => `${m} m`,
  formatDuration: (s: number) => `${s}s`,
  formatMeasurementDistance: (m: number, sys: string) =>
    sys === "imperial" ? `${m} ft` : `${m} m`,
}));
vi.mock("@/integration-api/runtime/useDateTimeFormat", () => ({
  useDateTimeFormat: () => ({
    time: (v: string | number | Date) => String(v),
    date: (v: string | number | Date) => String(v),
    dateTime: (v: string | number | Date) => String(v),
  }),
}));

import { NavBottomBar } from "./NavBottomBar";

describe("NavBottomBar", () => {
  it("renders remaining distance, duration, and an end button", () => {
    const html = renderToStaticMarkup(
      <NavBottomBar
        distanceRemaining={1200}
        durationRemaining={300}
        etaEpochMs={0}
        onEnd={() => {}}
        units="metric"
      />,
    );
    expect(html).toContain("1200 m");
    expect(html).toContain("300s");
    expect(html).toContain("end"); // i18n key passthrough
  });

  it("shows the search button only when onSearch is given", () => {
    const without = renderToStaticMarkup(
      <NavBottomBar durationRemaining={300} etaEpochMs={0} onEnd={() => {}} />,
    );
    expect(without).not.toContain("searchAlongRoute");
    const withSearch = renderToStaticMarkup(
      <NavBottomBar durationRemaining={300} etaEpochMs={0} onEnd={() => {}} onSearch={() => {}} />,
    );
    expect(withSearch).toContain("searchAlongRoute"); // search aria-label
  });
});
