// @vitest-environment jsdom

import { type AlongRoutePoi, type CategoryPlace, useNavigationStore } from "@openmapx/core";
import en from "@openmapx/i18n/locales/en.json";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  results: [] as AlongRoutePoi<CategoryPlace>[],
  addStop: vi.fn(),
  cancel: vi.fn(),
}));
vi.mock("@/lib/navigation/useRouteSearch", () => ({
  routeSearchQueryFor: (value: unknown) => value,
  useRouteSearch: () => ({
    results: fixture.results,
    isLoading: false,
    addStop: fixture.addStop,
    cancelAddStop: fixture.cancel,
  }),
}));
vi.mock("@/integration-api/map/MapContext", () => ({ useMapOptional: () => null }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useBrandSuggest: () => ({ data: undefined }),
}));
vi.mock("./RouteSearchResultsLayer", () => ({
  RouteSearchResultsLayer: ({
    results,
    onSelect,
  }: {
    results: AlongRoutePoi<CategoryPlace>[];
    onSelect: (poi: AlongRoutePoi<CategoryPlace>) => void;
  }) => (
    <button type="button" onClick={() => onSelect(results[0])}>
      Select stop
    </button>
  ),
}));

import { useRouteSearchStore } from "@/lib/navigation/routeSearchStore";
import { RouteSearchControl } from "./RouteSearchControl";

function view() {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      <RouteSearchControl />
    </NextIntlClientProvider>
  );
}
const poi = () =>
  ({
    place: { id: "stop", name: "River services", coordinates: [0.001, 0.001] },
    alongMeters: 100,
    deviationMeters: 20,
    detourSeconds: 3,
    detourMeters: 40,
  }) as AlongRoutePoi<CategoryPlace>;
beforeEach(() => {
  fixture.results = [poi()];
  fixture.cancel.mockReset();
  fixture.addStop.mockReset();
  useRouteSearchStore.getState().reset();
  useRouteSearchStore.getState().setCategoryKey("preset:amenity/fuel");
});
describe("route stop confidence", () => {
  it("exits search after its successful add changes the active route", async () => {
    let finish!: (value: boolean) => void;
    fixture.addStop.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    render(view());
    fireEvent.click(screen.getByText("Select stop"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    act(() =>
      useNavigationStore.setState({
        route: {
          geometry: [
            [0, 0],
            [0.002, 0],
          ],
        } as never,
      }),
    );
    await act(async () => finish(true));
    expect(useRouteSearchStore.getState().categoryKey).toBeNull();
  });
  it("cancels a pending request when the selected entrance changes", () => {
    fixture.addStop.mockReturnValue(new Promise(() => {}));
    const { rerender } = render(view());
    fireEvent.click(screen.getByText("Select stop"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fixture.cancel.mockClear();
    fixture.results = [{ ...poi(), place: { ...poi().place, routingEntrance: [0.003, 0] } }];
    rerender(view());
    expect(fixture.cancel).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(false);
  });
  it("labels approximation and coordinate fallback", () => {
    render(view());
    fireEvent.click(screen.getByText("Select stop"));
    expect(screen.getByText(/straight-line estimate/)).toBeTruthy();
    expect(screen.getByText(/entrance unknown/)).toBeTruthy();
  });
  it("updates the selected card and disables unreachable stops", () => {
    const { rerender } = render(view());
    fireEvent.click(screen.getByText("Select stop"));
    fixture.results = [
      {
        ...poi(),
        detour: {
          id: "stop",
          kind: "network",
          seconds: 600,
          meters: 4000,
          provider: "routing-fixture",
          access: { kind: "entrance", coordinates: [0.002, 0] },
          waypoints: [],
        },
      },
    ];
    rerender(view());
    expect(screen.getByText("+10 min by road")).toBeTruthy();
    expect(screen.getByText("+4.0 km")).toBeTruthy();
    expect(screen.getByText("Routing to known entrance")).toBeTruthy();
    fixture.results = [
      {
        ...poi(),
        detour: {
          id: "stop",
          kind: "unreachable",
          access: { kind: "coordinate", coordinates: [0.001, 0.001] },
          waypoints: [],
        },
      },
    ];
    rerender(view());
    expect(screen.getByText("No route to this stop")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
  });
  it("cancels a pending selection when the card is dismissed", () => {
    fixture.addStop.mockReturnValue(new Promise(() => {}));
    render(view());
    fireEvent.click(screen.getByText("Select stop"));
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fixture.cancel.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(fixture.cancel).toHaveBeenCalled();
  });
});
