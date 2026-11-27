import type { RoadConditionRouteImpact, Route } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RouteTrafficStatus } from "./RouteTrafficStatus";

vi.mock("@/lib/useRoutingEngines", () => {
  const engine = { available: true, modes: ["driving"], timeAware: true, exclusions: true };
  const engines = [
    { ...engine, id: "routing-valhalla", name: "Valhalla", trafficProof: true },
    { ...engine, id: "routing-osrm", name: "OSRM", trafficProof: false },
  ];
  return { useRoutingEngines: () => engines };
});

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
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Available road updates were used for this route.",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "This travel time may not include current traffic delays.",
  );
  act(() => {
    vi.advanceTimersByTime(30000);
  });
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Road updates need to be checked again. Refresh the route.",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).not.toHaveTextContent(
    "Available road updates were used",
  );
});
it("replaces old status on a new provider/route without proof", () => {
  const rendered = render(view());
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  rendered.rerender(view({ ...route, trafficProof: undefined }, "routing-osrm"));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent("OSRM");
  expect(screen.getByRole("dialog", { name: "About traffic" })).not.toHaveTextContent(
    "Available road updates were used",
  );
});
it("names a hosted engine as hosted and an unnamed source as unknown", () => {
  const rendered = render(view({ ...route, sourceIds: ["stadia-maps"] }));
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Route provider: Hosted Valhalla (Stadia Maps)",
  );
  rendered.rerender(
    <NextIntlClientProvider locale="en" messages={en}>
      <RouteTrafficStatus route={route} impact={impact} />
    </NextIntlClientProvider>,
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Route provider: Routing source unknown",
  );
});
it("removes a prior successful claim on failed assessment", () => {
  const rendered = render(view());
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  rendered.rerender(view(route, "routing-valhalla", { ...impact, availability: "unavailable" }));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Road updates couldn’t be checked.",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).not.toHaveTextContent(
    "Available road updates were used",
  );
});

it("rearms expiry when a clock correction makes the first callback early", () => {
  render(view());
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  vi.setSystemTime(now - 1000);
  act(() => {
    vi.advanceTimersByTime(30000);
  });
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Available road updates were used",
  );
  act(() => {
    vi.advanceTimersByTime(1000);
  });
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Road updates need to be checked again. Refresh the route.",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).not.toHaveTextContent(
    "Available road updates were used",
  );
});

it("keeps provider and application details out of the default summary", () => {
  render(view());
  expect(screen.queryByText("Traffic data unavailable")).toBeNull();
  expect(screen.queryByText(/Route provider: Valhalla/)).toBeNull();
  expect(screen.queryByText("Available road updates were used for this route.")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Traffic data unavailable",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Available road updates were used for this route.",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "Route provider: Valhalla",
  );
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(screen.queryByRole("dialog")).toBeNull();
});

it("updates the explanation when a new route has no estimate", () => {
  const r = { ...route, duration: 6300, baselineDuration: 3600 };
  const rendered = render(view(r));
  fireEvent.click(screen.getByRole("button", { name: "About traffic" }));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "The extra time is estimated by comparing this route with and without current traffic speeds.",
  );
  expect(screen.getByRole("dialog", { name: "About traffic" })).not.toHaveTextContent(
    "This travel time may not include current traffic delays.",
  );
  rendered.rerender(view(route));
  expect(screen.getByRole("dialog", { name: "About traffic" })).toHaveTextContent(
    "This travel time may not include current traffic delays.",
  );
});
