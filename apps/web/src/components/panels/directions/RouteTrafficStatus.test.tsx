import type { RoadConditionRouteImpact, Route } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { act, cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouteTrafficStatus } from "./RouteTrafficStatus";

const now = Date.parse("2026-10-07T02:00:00Z");
const route: Route = {
  mode: "driving",
  duration: 2000,
  distance: 10000,
  geometry: [],
  legs: [],
  steps: [],
  trafficProof: {
    schemaVersion: 1,
    requestId: "request",
    writeId: "write",
    graphGeneration: "graph",
    engineBootId: "boot",
    endpoint: "route",
    costing: "auto",
    evaluatedAt: new Date(now - 1000).toISOString(),
    validUntil: new Date(now + 60000).toISOString(),
  },
};
const impact: RoadConditionRouteImpact = {
  availability: "current",
  reasons: [],
  evaluatedAt: new Date(now).toISOString(),
  validUntil: new Date(now + 30000).toISOString(),
};
const view = (
  r = route,
  provider = "routing-valhalla",
  assessment: RoadConditionRouteImpact | undefined = impact,
) => (
  <NextIntlClientProvider locale="en" messages={en}>
    <RouteTrafficStatus route={r} provider={provider} impact={assessment} />
  </NextIntlClientProvider>
);
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});
it("expires held verification at the lease and never claims congestion causality", () => {
  render(view());
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent(
    "Road-condition application verified",
  );
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent(
    "Congestion effect on ETA not verified",
  );
  act(() => {
    vi.advanceTimersByTime(30000);
  });
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent(
    "Road-condition evidence expired",
  );
  expect(screen.getByTestId("route-traffic-status")).not.toHaveTextContent("application verified");
});
it("replaces old status on a new provider/route without proof", () => {
  const rendered = render(view());
  rendered.rerender(view({ ...route, trafficProof: undefined }, "routing-osrm"));
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent("OSRM");
  expect(screen.getByTestId("route-traffic-status")).not.toHaveTextContent("application verified");
});
it("removes a prior successful claim on failed assessment", () => {
  const rendered = render(view());
  rendered.rerender(view(route, "routing-valhalla", { ...impact, availability: "unavailable" }));
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent(
    "Road-condition check unavailable",
  );
});

it("rearms expiry when a clock correction makes the first callback early", () => {
  render(view());
  vi.setSystemTime(now - 1000);
  act(() => {
    vi.advanceTimersByTime(30000);
  });
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent("application verified");
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByTestId("route-traffic-status")).toHaveTextContent(
    "Road-condition evidence expired",
  );
  expect(screen.getByTestId("route-traffic-status")).not.toHaveTextContent("application verified");
});
