import type { Place } from "@openmapx/core";
import { expect, it, vi } from "vitest";
import { render, screen } from "@/test";

vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());
vi.mock("@/lib/useInView", () => ({ useInView: () => [() => {}, true] }));
const rows = vi.hoisted(() => ({ hotels: [] as unknown[], neighborhoods: [] as unknown[] }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<Record<string, unknown>>()),
  useCategorySearch: () => ({ data: { results: rows.hotels } }),
  useNeighborhoods: () => ({ data: { neighborhoods: rows.neighborhoods } }),
}));

import { PlaceCitySections } from "./PlaceCitySections";

it("credits only fields on the ten retained hotel cards and actual neighborhood labels", () => {
  const receipt = (name: string) => [{ sourceId: name, name }];
  rows.hotels = Array.from({ length: 11 }, (_, index) => ({
    id: `hotel${index}`,
    name: `Hotel${index}`,
    coordinates: [6, 51],
    contributors: receipt("Hidden phone"),
    fieldContributors: {
      name: receipt(index < 10 ? "Hotel label" : "Capped hotel"),
      category: [],
      phone: receipt("Hidden phone"),
    },
  }));
  rows.neighborhoods = [
    {
      id: "node/1",
      name: "Quarter",
      coordinates: [6, 51],
      description: "Quarter blurb",
      contributors: receipt("Hidden coordinates"),
      fieldContributors: {
        name: receipt("Quarter name"),
        description: receipt("Quarter text"),
        coordinates: receipt("Hidden coordinates"),
      },
    },
  ];
  render(
    <PlaceCitySections
      place={{ coordinates: [6, 51], name: "City", boundingBox: [5, 50, 7, 52] } as Place}
      onNavigateToInfo={() => {}}
    />,
  );
  expect(screen.getByText("Hotel label")).toBeTruthy();
  expect(screen.getByText("Quarter name")).toBeTruthy();
  expect(screen.getByText("Quarter text")).toBeTruthy();
  expect(screen.queryByText("Capped hotel")).toBeNull();
  expect(screen.queryByText("Hidden phone")).toBeNull();
  expect(screen.queryByText("Hidden coordinates")).toBeNull();
});
