import { useStreetLevelStore } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/integration-api/components/useStreetLevelProviders", () => ({
  useStreetLevelProviders: () => ({ providers: [{ id: "panoramax" }], isLoading: false }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({
  useMap: () => ({ mapRef: { current: null }, mapReady: false }),
}));

import { nearestFeature, Pegman } from "./Pegman";

afterEach(() => {
  useStreetLevelStore.getState().closePanel();
});

it("opens street imagery with Enter and exposes its active state", () => {
  render(<Pegman />);
  const control = screen.getByRole("button", { name: "streetLevel.toggleCoverage" });
  expect(control.getAttribute("aria-pressed")).toBe("false");
  fireEvent.keyDown(control, { key: "Enter" });
  expect(useStreetLevelStore.getState().panelOpen).toBe(true);
  expect(control.getAttribute("aria-pressed")).toBe("true");
  fireEvent.keyDown(control, { key: " ", code: "Space" });
  expect(useStreetLevelStore.getState().panelOpen).toBe(false);
  expect(control.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(control, { detail: 0 });
  expect(useStreetLevelStore.getState().panelOpen).toBe(true);
  fireEvent.click(control, { detail: 1 });
  expect(useStreetLevelStore.getState().panelOpen).toBe(true);
});

describe("nearestFeature", () => {
  const features = [
    { id: "far", providerId: "panoramax", screenX: 100, screenY: 100 },
    { id: "near", providerId: "mapillary", screenX: 12, screenY: 12 },
  ];

  it("picks the closest candidate across providers", () => {
    expect(nearestFeature(features, 10, 10)?.id).toBe("near");
  });

  it("preserves the owning provider", () => {
    expect(nearestFeature(features, 10, 10)?.providerId).toBe("mapillary");
  });

  it("returns null when there are no candidates", () => {
    expect(nearestFeature([], 10, 10)).toBeNull();
  });
});
