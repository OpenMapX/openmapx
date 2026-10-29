import type { DirectionsResult, Route } from "@openmapx/core";
import type { Attribution } from "@openmapx/mobility-core/attribution";
import { describe, expect, it } from "vitest";
import { withRoutingContributors } from "./routing-contributors";

const route: Route = {
  mode: "driving",
  distance: 1,
  duration: 1,
  geometry: [
    [0, 0],
    [1, 1],
  ],
  legs: [],
  steps: [],
};
const result = (routes: Route[]): DirectionsResult => ({
  waypoints: [
    [0, 0],
    [1, 1],
  ],
  activeRouteIndex: 0,
  routes,
});

it("captures actual supplier metadata before an asynchronous routing call", async () => {
  let resolve!: (result: DirectionsResult) => void;
  const receipt = {
    sourceId: "a",
    name: "A",
    attributionText: "notice before",
    publisher: { name: "Before" },
  };
  const provider = withRoutingContributors(
    {
      id: "p",
      supportedModes: ["driving"],
      getRoute: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    () => [receipt],
  );
  const pending = provider.getRoute([], "driving");
  receipt.attributionText = "notice after";
  receipt.publisher.name = "After";
  resolve(result([{ ...route, sourceIds: ["a"] }]));
  expect((await pending).routes[0].contributors).toEqual([
    { sourceId: "a", name: "A", attributionText: "notice before", publisher: { name: "Before" } },
  ]);
});

describe("route adapter receipt boundaries", () => {
  it("keeps exact backend selection and canonical empty receipts on both methods", async () => {
    const envelope: Attribution[] = [
      { sourceId: "a", name: "A" },
      { sourceId: "b", name: "B" },
    ];
    const routes = [{ ...route, sourceIds: ["a"] }, { ...route, contributors: [] }, { ...route }];
    const provider = withRoutingContributors(
      {
        id: "p",
        supportedModes: ["driving"],
        getRoute: async () => result(routes),
        optimizeRoute: async () => result(routes),
      },
      () => envelope,
    );
    const optimize = provider.optimizeRoute;
    if (!optimize) throw new Error("optimize capability was lost");
    for (const captured of [
      await provider.getRoute([], "driving"),
      await optimize([], "driving"),
    ]) {
      expect(captured.routes.map((entry) => entry.contributors)).toEqual([[envelope[0]], [], []]);
    }
  });
});

it("captures matrix cell receipts before acquisition and preserves explicit empty cells", async () => {
  const receipt = { sourceId: "matrix", name: "Matrix", attributionText: "Before" };
  let resolve!: (
    rows: ({ seconds: number; km: number; contributors?: Attribution[] } | null)[][],
  ) => void;
  const provider = withRoutingContributors(
    {
      id: "p",
      supportedModes: ["driving"],
      getRoute: async () => result([]),
      getMatrix: () =>
        new Promise((done) => {
          resolve = done;
        }),
    },
    () => [receipt],
  );
  const pending = provider.getMatrix?.([], []);
  receipt.attributionText = "After";
  resolve([[{ seconds: 1, km: 1 }, { seconds: 2, km: 2, contributors: [] }, null]]);
  const rows = await pending;
  expect(rows?.[0][0]?.contributors).toEqual([{ ...receipt, attributionText: "Before" }]);
  expect(rows?.[0][1]?.contributors).toEqual([]);
  expect(rows?.[0][2]).toBeNull();
});

it("keeps a malformed field map authoritative instead of inheriting a record grant", async () => {
  const receipt = { sourceId: "provider", name: "Provider" };
  const provider = withRoutingContributors(
    {
      id: "p",
      supportedModes: ["driving"],
      getRoute: async () =>
        result([
          {
            ...route,
            contributors: [receipt],
            fieldContributors: {
              geometry: [{ ...receipt, licensing: { version: 2, bindings: [] } }],
            } as unknown as Route["fieldContributors"],
          },
        ]),
    },
    () => [receipt],
  );
  const captured = (await provider.getRoute([], "driving")).routes[0];
  expect(captured.fieldContributors).toEqual({});
  const { contributorsForField } = await import("@openmapx/mobility-core/contributors");
  expect(contributorsForField(captured, "geometry")).toEqual([]);
});
