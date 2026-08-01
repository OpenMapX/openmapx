import type { Route } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { describe, expect, it } from "vitest";
import { RouteCard } from "./RouteCard";

const baseRoute: Route = {
  distance: 118132,
  duration: 5194,
  geometry: [
    [6.08, 50.77],
    [6.68, 51.51],
  ],
  legs: [],
  steps: [],
  mode: "driving",
  summary: "via A46",
};

const renderCard = (route: Route) =>
  render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <RouteCard
        route={route}
        index={0}
        active
        onSelect={() => {}}
        onDetails={() => {}}
        units="metric"
      />
    </NextIntlClientProvider>,
  );

describe("RouteCard traffic delta", () => {
  it("shows nothing when there is no baseline duration", () => {
    renderCard(baseRoute);
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
  });

  it("shows nothing when the delay is under five minutes", () => {
    // 4 min on a 40 min baseline: over 10% but under the absolute floor.
    renderCard({ ...baseRoute, duration: 2640, baselineDuration: 2400 });
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
  });

  it("shows nothing when the delay is under ten percent", () => {
    // 6 min on a 90 min baseline: over the absolute floor but under the ratio.
    renderCard({ ...baseRoute, duration: 5760, baselineDuration: 5400 });
    expect(screen.queryByTestId("traffic-delay")).toBeNull();
  });

  it("shows the delay once both thresholds are met", () => {
    // 12 min on a 75 min baseline = 16% -> light band.
    renderCard({ ...baseRoute, duration: 5220, baselineDuration: 4500 });
    const el = screen.getByTestId("traffic-delay");
    expect(el.textContent).toContain("12 min");
    expect(getComputedStyle(el).color).toBe("var(--omx-traffic-light)");
  });

  it("escalates the colour with the delay", () => {
    // 45 min on a 60 min baseline = 75% -> heavy band.
    renderCard({ ...baseRoute, duration: 6300, baselineDuration: 3600 });
    expect(getComputedStyle(screen.getByTestId("traffic-delay")).color).toBe(
      "var(--omx-traffic-heavy)",
    );
  });
});
