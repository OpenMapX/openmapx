import { type SavedList, useSavedPlacesStore } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const LEGACY_CUSTOM_LIST = "$trip";
const state = vi.hoisted(() => ({ name: "", update: vi.fn(), remove: vi.fn() }));
vi.mock("@emoji-mart/react", () => ({ default: () => null }));
vi.mock("@/integration-api/map/MapContext", () => ({ useMap: () => ({ flyTo: vi.fn() }) }));
vi.mock("./ShareListDialog", () => ({ ShareListDialog: () => null }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedLists: () => ({
    data: [
      { id: "list-1", name: state.name, icon: null, isPrivate: true, placeCount: 0 } as SavedList,
    ],
  }),
  useSavedListPlaces: () => ({ data: [], isLoading: false }),
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
