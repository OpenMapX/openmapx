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
import * as savedPlaceActions from "@/lib/openSavedPlace";

const LEGACY_CUSTOM_LIST = "$trip";
const state = vi.hoisted(() => ({
  places: [] as SavedPlace[],
  name: "",
  update: vi.fn(),
  remove: vi.fn(),
  updatePlace: vi.fn(),
}));
vi.mock("@emoji-mart/react", () => ({ default: () => null }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));
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
  useUpdatePlace: () => ({ mutate: state.updatePlace }),
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
  state.updatePlace.mockClear();
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

it("adds and edits notes without opening the place, and opens rows through openSavedPlace", () => {
  const place: SavedPlace = {
    id: "note-place",
    listId: "list-1",
    name: "Public landmark",
    address: null,
    placeId: null,
    note: null,
    sortOrder: 0,
    lat: 51,
    lng: 8,
    createdAt: "2026-10-20T00:00:00Z",
  };
  state.places = [place];
  const open = vi.spyOn(savedPlaceActions, "openSavedPlace");
  const view = renderDetail();
  fireEvent.click(screen.getByRole("button", { name: "+ Note" }));
  expect(open).not.toHaveBeenCalled();
  const note = screen.getByPlaceholderText("Note");
  fireEvent.change(note, { target: { value: "Visit in daylight" } });
  fireEvent.keyDown(note, { key: "Enter" });
  expect(state.updatePlace).toHaveBeenCalledWith(
    { id: "note-place", note: "Visit in daylight" },
    expect.objectContaining({ onSuccess: expect.any(Function) }),
  );
  fireEvent.keyDown(note, { key: "Escape" });
  state.places = [{ ...place, note: "Visit in daylight" }];
  view.rerender(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <SavedListDetail />
    </NextIntlClientProvider>,
  );
  expect(screen.queryByRole("button", { name: "Visit in daylight" })).not.toBeInTheDocument();
  expect(screen.getByText("Visit in daylight")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Edit note" }));
  expect(screen.getByPlaceholderText("Note")).toHaveValue("Visit in daylight");
  expect(open).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByPlaceholderText("Note"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: /Public landmark/ }));
  expect(open).toHaveBeenCalledWith(state.places[0], expect.any(Function));
});
