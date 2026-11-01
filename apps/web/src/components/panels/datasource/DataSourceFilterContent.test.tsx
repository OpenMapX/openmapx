// @vitest-environment jsdom

import {
  type DataSourcePartialReason,
  type DataSourceResult,
  useDataSourceStore,
} from "@openmapx/core";
import en from "@openmapx/i18n/locales/en.json";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  results: [] as DataSourceResult[],
  partial: null as DataSourcePartialReason | null,
  isFetching: false,
  refetch: vi.fn(),
  zoomIn: vi.fn(),
}));

vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useDataSources: () => ({
    data: {
      sources: [
        {
          id: "fuel",
          name: "Fuel",
          categoryChipLabel: "Fuel",
          minZoom: 10,
          markerStyle: { color: "#000", iconPath: "" },
          showResultsList: true,
          placeCategory: "Fuel station",
          placeCategoryRaw: "fuel",
          filters: [],
        },
      ],
    },
  }),
  useDataSourceSearch: () => ({
    data: fixture.results,
    isLoading: false,
    isFetching: fixture.isFetching,
    isError: false,
    partial: fixture.partial,
    refetch: fixture.refetch,
    attributions: [],
    freshness: undefined,
  }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ zoomIn: fixture.zoomIn }) }));
vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: () => () => "",
}));

import { DataSourceFilterContent } from "./DataSourceFilterContent";

function view() {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <DataSourceFilterContent />
    </NextIntlClientProvider>
  );
}

function station(id: string, name: string): DataSourceResult {
  return { id, name, coordinates: [13.4, 52.5], source: "fuel" } as DataSourceResult;
}

beforeEach(() => {
  fixture.results = [];
  fixture.partial = null;
  fixture.isFetching = false;
  fixture.refetch.mockReset();
  fixture.zoomIn.mockReset();
  const store = useDataSourceStore.getState();
  store.setActiveSource("fuel");
  store.setSearchBbox({ south: 52.4, west: 13.3, north: 52.6, east: 13.5 });
  store.setViewport({ south: 52.4, west: 13.3, north: 52.6, east: 13.5 }, 14);
});

describe("data-source answers that lack results", () => {
  it("says a source did not answer instead of reporting none in view, and asks again", () => {
    fixture.partial = "unavailable";
    render(view());

    expect(screen.getByRole("status").textContent).toContain("Not every source answered");
    expect(screen.queryByText("0 in view")).toBeNull();
    expect(screen.queryByRole("button", { name: "Zoom in" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(fixture.refetch).toHaveBeenCalledTimes(1);
    expect(fixture.zoomIn).not.toHaveBeenCalled();
  });

  it("keeps the results that did arrive beside the notice", () => {
    fixture.partial = "unavailable";
    fixture.results = [station("a", "Aral Alexanderplatz")];
    render(view());

    expect(screen.getByText("Aral Alexanderplatz")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain("Not every source answered");
  });

  it("shows the retry as pending while the source is asked again beside earlier results", () => {
    fixture.partial = "unavailable";
    fixture.results = [station("a", "Aral Alexanderplatz")];
    fixture.isFetching = true;
    render(view());

    expect(screen.getByRole("status").querySelector('[role="progressbar"]')).not.toBeNull();
  });

  it("shows loading, not the notice, while an empty view is asked again", () => {
    fixture.partial = "unavailable";
    fixture.isFetching = true;
    render(view());

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("Loading...")).toBeTruthy();
  });

  it("still offers to zoom in when a source fetched only part of the view", () => {
    fixture.partial = "area";
    render(view());

    expect(screen.getByRole("status").textContent).toContain("Zoom in to load more");
    expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(fixture.zoomIn).toHaveBeenCalledTimes(1);
  });

  it("reports a complete empty answer as none in view, with no notice", () => {
    render(view());

    expect(screen.getByText("0 in view")).toBeTruthy();
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("drops the notice once the answer for the new view, provider or filters is complete", () => {
    fixture.partial = "unavailable";
    const { rerender } = render(view());
    expect(screen.getByRole("status")).toBeTruthy();

    fixture.partial = null;
    rerender(view());

    expect(screen.queryByRole("status")).toBeNull();
    expect(screen.getByText("0 in view")).toBeTruthy();
  });
});
