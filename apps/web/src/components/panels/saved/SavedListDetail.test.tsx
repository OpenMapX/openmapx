import {
  type SavedList,
  type SavedPlace,
  usePlaceStore,
  useSavedPlacesStore,
} from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LEGACY_CUSTOM_LIST = "$trip";
const state = vi.hoisted(() => ({
  places: [] as SavedPlace[],
  name: "",
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@emoji-mart/react", () => ({ default: () => null }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
vi.mock("./PlaceThumbnail", () => ({ PlaceThumbnail: () => null }));
vi.mock("./ShareListDialog", () => ({ ShareListDialog: () => null }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedLists: () => ({
    data: [
      { id: "list-1", name: state.name, icon: null, isPrivate: true, placeCount: 0 } as SavedList,
    ],
  }),
  useSavedListPlaces: () => ({ data: state.places, isLoading: false }),
  useUpdateList: () => ({ mutate: state.update }),
  useDeleteList: () => ({ mutate: state.remove }),
  useUpdatePlace: () => ({ mutate: vi.fn() }),
}));

const { SavedListDetail } = await import("./SavedListDetail");
function renderDetail() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <SavedListDetail />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.name = LEGACY_CUSTOM_LIST;
  state.places = [];
  state.update.mockClear();
  state.remove.mockClear();
  useSavedPlacesStore.getState().selectList("list-1");
});

describe("saved list name ownership", () => {
  it("shows the literal legacy name and lets its owner rename it", () => {
    renderDetail();
    const input = screen.getByRole("textbox");
    expect(input).toHaveValue("$trip");
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Trip" } });
    fireEvent.blur(input);
    expect(state.update).toHaveBeenCalledWith({ id: "list-1", name: "Trip" });
  });

  it.each(["$favorites", "$wantToGo", "$starredPlaces"])(
    "keeps %s translated and read-only",
    (name) => {
      state.name = name;
      renderDetail();
      expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
      expect(
        screen.getByText(en.saved[name.slice(1) as keyof typeof en.saved] as string),
      ).toBeInTheDocument();
    },
  );
});

it("shows frozen row credits and reconstructs selected details with exact field snapshots", () => {
  const receipt = { sourceId: "original", name: "Original row publisher" };
  const geometry = { sourceId: "coordinate", name: "Coordinate publisher" };
  state.places = [
    {
      id: "saved-1",
      listId: "list-1",
      placeId: null,
      note: null,
      sortOrder: 0,
      createdAt: "2026-10-15T00:00:00Z",
      name: "Saved name",
      address: "Saved address",
      lat: 50,
      lng: 8,
      fieldContributors: { name: [receipt], address: [], lat: [geometry], lng: [] },
    },
  ];
  renderDetail();
  expect(screen.getByText("Original row publisher")).toBeInTheDocument();
  expect(screen.queryByText("Coordinate publisher")).not.toBeInTheDocument();
  fireEvent.click(screen.getByText("Saved name"));
  expect(usePlaceStore.getState().selectedPlace?.fieldContributors).toEqual({
    name: [receipt],
    address: [],
    coordinates: [geometry],
    "coordinates.1": [geometry],
    "coordinates.0": [],
  });
});

it("collects mounted saved rows into one footer and removes replaced supplier receipts", () => {
  const receipt = { sourceId: "shared", name: "Shared saved supplier" };
  const row = (id: string): SavedPlace => ({
    id,
    listId: "list-1",
    placeId: null,
    note: null,
    sortOrder: 0,
    createdAt: "2026-10-16T00:00:00Z",
    name: id,
    address: "Address",
    lat: 50,
    lng: 8,
    fieldContributors: { name: [receipt], address: [] },
  });
  state.places = [row("one"), row("two")];
  const view = renderDetail();
  expect(screen.getAllByText("Shared saved supplier")).toHaveLength(1);
  expect(screen.getAllByRole("button", { name: "Credits" })).toHaveLength(1);
  state.places = [
    {
      ...row("three"),
      fieldContributors: { name: [{ sourceId: "new", name: "New saved supplier" }] },
    },
  ];
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <SavedListDetail />
    </NextIntlClientProvider>,
  );
  expect(screen.queryByText("Shared saved supplier")).not.toBeInTheDocument();
  expect(screen.getByText("New saved supplier")).toBeInTheDocument();
});
