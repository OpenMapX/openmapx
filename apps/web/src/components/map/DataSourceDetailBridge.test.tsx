import { createPlace, useDataSourceStore, usePlaceStore, useSidebarStore } from "@openmapx/core";
import { act, render } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, expect, it, vi } from "vitest";
import { DataSourceDetailBridge } from "./DataSourceDetailBridge";

const response = vi.hoisted(() => ({
  detail: { id: "P", name: "Parking", coordinates: [8, 50] } as Record<string, unknown>,
}));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useDataSourceDetail: () => ({ data: response.detail }),
  useDataSources: () => ({ data: undefined }),
}));
const resolveToken = vi.hoisted(
  () => (value: unknown) =>
    typeof value === "object" && value !== null ? `t:${(value as { $t: string }).$t}` : "",
);
vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: () => resolveToken,
}));

beforeEach(() => {
  response.detail = { id: "P", name: "Parking", coordinates: [8, 50] };
  useDataSourceStore.getState().selectItem("parking", "P");
  useSidebarStore.getState().closeAll();
});

it("titles a detail its sources name nothing by its translated fallback name", () => {
  useDataSourceStore.getState().selectItem("fuel", "F");
  response.detail = {
    id: "F",
    name: "",
    fallbackName: { $t: "stationFallbackName" },
    coordinates: [8, 50],
    sources: ["osm-fuel"],
    sections: [],
  };
  const view = render(<DataSourceDetailBridge />);
  expect(usePlaceStore.getState().selectedPlace?.name).toBe("t:stationFallbackName");
  view.unmount();
  useDataSourceStore.getState().clearSelection();
  usePlaceStore.getState().setSelectedPlace(null);
});

it("shows a site's own website, or else its operator's, as the place's website", () => {
  const websiteOf = (detail: Record<string, unknown>) => {
    usePlaceStore.getState().setSelectedPlace(null);
    useDataSourceStore.getState().selectItem("ev-charging", "C");
    response.detail = { id: "C", name: "Ladepark", coordinates: [8, 50], sections: [], ...detail };
    const view = render(<DataSourceDetailBridge />);
    const website = usePlaceStore.getState().selectedPlace?.website;
    view.unmount();
    useDataSourceStore.getState().clearSelection();
    usePlaceStore.getState().setSelectedPlace(null);
    return website;
  };

  expect(websiteOf({ website: "https://ladepark.example" })).toBe("https://ladepark.example");
  expect(websiteOf({ operator: { name: "EnBW", url: "https://enbw.com" } })).toBe(
    "https://enbw.com",
  );
  expect(websiteOf({ website: "javascript:alert(1)" })).toBeUndefined();
});

it("does not reclaim a newer transit selection on a retained data-source refetch", () => {
  usePlaceStore.getState().setSelectedPlace(
    createPlace({
      primaryScheme: "parking",
      ids: { parking: "P" },
      name: "Parking",
      address: "",
      coordinates: [8, 50],
    }),
  );
  const view = render(<DataSourceDetailBridge />);
  const stop = createPlace({
    primaryScheme: "db",
    ids: { db: "A" },
    name: "Station A",
    address: "",
    coordinates: [8, 50],
  });
  act(() => usePlaceStore.getState().setSelectedPlace(stop));
  const revision = usePlaceStore.getState().selectionRevision;
  response.detail = { ...response.detail, name: "Refetched parking" };
  view.rerender(<DataSourceDetailBridge />);
  expect(usePlaceStore.getState().selectedPlace).toBe(stop);
  expect(usePlaceStore.getState().selectionRevision).toBe(revision);
  view.unmount();
  useDataSourceStore.getState().clearSelection();
  usePlaceStore.getState().setSelectedPlace(null);
});

it("enriches the selected data-source preview and refetch without starting new detail sessions", () => {
  const preview = createPlace({
    primaryScheme: "parking",
    ids: { parking: "P" },
    name: "Preview",
    address: "",
    coordinates: [8, 50],
  });
  usePlaceStore.getState().setSelectedPlace(preview);
  const revision = usePlaceStore.getState().selectionRevision;
  usePlaceStore.getState().setActiveRouteId("route");
  const view = render(
    <StrictMode>
      <DataSourceDetailBridge />
    </StrictMode>,
  );
  expect(usePlaceStore.getState().selectedPlace?.dataSourceDetail?.name).toBe("Parking");
  expect(usePlaceStore.getState().selectionRevision).toBe(revision);
  expect(usePlaceStore.getState().activeRouteId).toBe("route");
  response.detail = { ...response.detail, name: "Updated parking" };
  view.rerender(
    <StrictMode>
      <DataSourceDetailBridge />
    </StrictMode>,
  );
  expect(usePlaceStore.getState().selectedPlace?.name).toBe("Updated parking");
  expect(usePlaceStore.getState().selectionRevision).toBe(revision);
  view.unmount();
  usePlaceStore.getState().setSelectedPlace(null);
  useDataSourceStore.getState().clearSelection();
});

it("opens a fresh data-source choice without a preview and permits its later refetch", () => {
  usePlaceStore.getState().setSelectedPlace(null);
  const view = render(<DataSourceDetailBridge />);
  expect(usePlaceStore.getState().selectedPlace?.id).toBe("parking:P");
  const revision = usePlaceStore.getState().selectionRevision;
  response.detail = { ...response.detail, name: "Refetched parking" };
  view.rerender(<DataSourceDetailBridge />);
  expect(usePlaceStore.getState().selectedPlace?.name).toBe("Refetched parking");
  expect(usePlaceStore.getState().selectionRevision).toBe(revision);
  response.detail = { ...response.detail, id: "Q", name: "Another parking" };
  act(() => useDataSourceStore.getState().selectItem("parking", "Q"));
  expect(usePlaceStore.getState().selectedPlace?.id).toBe("parking:Q");
  expect(usePlaceStore.getState().selectionRevision).toBeGreaterThan(revision);
  view.unmount();
  useDataSourceStore.getState().clearSelection();
  usePlaceStore.getState().setSelectedPlace(null);
});

it("starts a new detail session for an explicit same-item choice without a preview", () => {
  usePlaceStore.getState().setSelectedPlace(
    createPlace({
      primaryScheme: "parking",
      ids: { parking: "P" },
      name: "Parking",
      address: "",
      coordinates: [8, 50],
    }),
  );
  const view = render(<DataSourceDetailBridge />);
  act(() => {
    usePlaceStore.getState().setActiveRouteId("route");
    usePlaceStore.getState().focusTransitMapFeature({ kind: "parking", id: "P" });
  });
  const revision = usePlaceStore.getState().selectionRevision;
  act(() => useDataSourceStore.getState().selectItem("parking", "P"));
  expect(usePlaceStore.getState().selectionRevision).toBeGreaterThan(revision);
  expect(usePlaceStore.getState().activeRouteId).toBeNull();
  expect(usePlaceStore.getState().transitMapFocus).toBeNull();
  view.unmount();
  useDataSourceStore.getState().clearSelection();
  usePlaceStore.getState().setSelectedPlace(null);
});

it("keeps the session revision already advanced by a same-item marker preview", () => {
  const preview = createPlace({
    primaryScheme: "parking",
    ids: { parking: "P" },
    name: "Parking",
    address: "",
    coordinates: [8, 50],
  });
  usePlaceStore.getState().setSelectedPlace(preview);
  const view = render(<DataSourceDetailBridge />);
  const revision = usePlaceStore.getState().selectionRevision;
  act(() => {
    useDataSourceStore.getState().selectItem("parking", "P");
    usePlaceStore.getState().setSelectedPlace(preview);
  });
  expect(usePlaceStore.getState().selectionRevision).toBe(revision + 1);
  expect(usePlaceStore.getState().selectedPlace?.dataSourceDetail?.name).toBe("Parking");
  view.unmount();
  useDataSourceStore.getState().clearSelection();
  usePlaceStore.getState().setSelectedPlace(null);
});
