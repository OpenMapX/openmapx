vi.mock(
  "next/navigation",
  async () => (await import("@/test/adminNavigation")).adminNavigationMock,
);

import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, createTestQueryClient, render, screen } from "@/test";
import { DataWorkspace } from "./DataWorkspace";

const reads = vi.hoisted(() => [] as string[]);
vi.mock("../activity/activityQueries", () => ({
  useActivityClient: () => ({ apiUrl: "http://data.test", client: {} }),
}));
vi.mock("@/lib/admin/serviceAdmin", () => ({
  serviceAdminQueries: () => ({
    data: () => ({
      queryKey: ["directory"],
      queryFn: () => {
        reads.push("aggregate");
        return { osm: { total: 7, unavailable: false }, builds: [] };
      },
    }),
  }),
}));
vi.mock("../services/OvertureMaintenance", () => ({
  OvertureMaintenance: () => {
    reads.push("overture");
    return <div>Overture family</div>;
  },
}));
vi.mock("../services/SearchIndexMaintenance", () => ({
  SearchIndexMaintenance: () => {
    reads.push("search");
    return <div>Search family</div>;
  },
}));
vi.mock("../services/AmbientPlacesMaintenance", () => ({
  AmbientPlacesMaintenance: () => <div>Ambient family</div>,
}));
vi.mock("../services/NotablePlacesMaintenance", () => ({
  NotablePlacesMaintenance: () => <div>Notable family</div>,
}));
afterEach(() => {
  cleanup();
  reads.length = 0;
});
it("uses only the aggregate read for the directory and links every owned domain", async () => {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DataWorkspace />
    </QueryClientProvider>,
  );
  await screen.findByText(/7 extracts/);
  expect(reads).toEqual(["aggregate"]);
  for (const topic of [
    "osm",
    "overture",
    "search",
    "transit",
    "coverage",
    "transfers",
    "operations",
  ])
    expect(document.querySelector(`a[href="/admin/data/${topic}"]`)).not.toBeNull();
  expect(screen.queryByText("Overture family")).toBeNull();
});
it("mounts only the selected domain's status family", () => {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DataWorkspace topic="search" />
    </QueryClientProvider>,
  );
  expect(screen.getByText("Search family")).toBeInTheDocument();
  expect(screen.getByText("Notable family")).toBeInTheDocument();
  expect(reads).toEqual(["search"]);
});
