import type { ElevationProfile as Profile, Route } from "@openmapx/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, it, vi } from "vitest";
import { ElevationProfile } from "./ElevationProfile";

const state = vi.hoisted(() => ({ profile: null as Profile | null }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useElevation: () => ({ data: state.profile, isLoading: false }),
}));
vi.mock("next-intl", () => ({ useTranslations: () => (key: string) => key }));
vi.mock("next/dynamic", () => ({ default: () => () => <span>Chart</span> }));
vi.mock("./ElevationHoverContext", () => ({ useElevationHover: () => ({ setPoints: () => {} }) }));
vi.mock("./ElevationStats", () => ({ ElevationStats: () => <span>Profile statistics</span> }));
const route: Route = {
  mode: "driving",
  geometry: [
    [0, 0],
    [1, 1],
  ],
  distance: 1,
  duration: 1,
  legs: [],
  steps: [],
  contributors: [{ sourceId: "unused", name: "Unused route height" }],
};
const receipt = {
  sourceId: "height",
  name: "Captured height",
  attributionText: "Captured mandatory notice",
};
beforeEach(() => {
  state.profile = null;
});
function profile(count: number): Profile {
  return {
    points: Array.from({ length: count }, (_, i) => ({
      distance: i * 50,
      elevation: i,
      lngLat: [0, 0],
    })),
    stats: {
      totalAscent: 0,
      totalDescent: 0,
      maxElevation: 1,
      minElevation: 0,
      averageGrade: 0,
      maxGrade: 0,
    },
    contributors: [receipt],
  };
}
it("credits the profile's captured input receipt when compact stats or expanded chart are visible", async () => {
  state.profile = profile(2);
  render(<ElevationProfile route={route} units="metric" />);
  expect(screen.getByText("Captured height")).toBeInTheDocument();
  fireEvent.mouseOver(screen.getByText("Captured height"));
  await waitFor(() => expect(screen.getByText("Captured mandatory notice")).toBeInTheDocument());
  expect(screen.queryByText("Unused route height")).toBeNull();
  fireEvent.click(screen.getByText("title"));
  expect(screen.getByText("Chart")).toBeInTheDocument();
  expect(screen.getByText("Captured height")).toBeInTheDocument();
});
it("has no receipt for an undisplayed single-point profile", () => {
  state.profile = profile(1);
  render(<ElevationProfile route={route} units="metric" />);
  expect(screen.queryByText("Captured height")).toBeNull();
  expect(screen.queryByText("Profile statistics")).toBeNull();
});
