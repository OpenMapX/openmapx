import { ApiClientError, type SavedList } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ lists: [] as SavedList[], create: vi.fn() }));
vi.mock("./ImportPlacesPicker", () => ({ ImportPlacesPicker: () => null }));
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  useSavedLists: () => ({ data: state.lists, isLoading: false }),
  useCreateList: () => ({ mutate: state.create, isPending: false }),
  useDeleteList: () => ({ mutate: vi.fn() }),
}));

const { SavedListsTab } = await import("./SavedListsTab");
const list = (name: string) =>
  ({ id: name, name, icon: null, isPrivate: true, placeCount: 0 }) as unknown as SavedList;

function renderTab() {
  return render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <SavedListsTab />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  state.create.mockReset();
  state.lists = [list("$favorites")];
});

describe("creating a list from the Lists tab", () => {
  it("numbers a new unnamed list so it does not repeat an existing name", () => {
    state.lists.push(list(en.saved.untitledList), list(`${en.saved.untitledList} (2)`));
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: en.saved.newList }));
    expect(state.create.mock.calls[0][0]).toEqual({ name: `${en.saved.untitledList} (3)` });
  });

  it("explains a refused creation at the list limit", async () => {
    renderTab();
    fireEvent.click(screen.getByRole("button", { name: en.saved.newList }));
    const options = state.create.mock.calls[0][1] as { onError: (error: unknown) => void };
    act(() =>
      options.onError(new ApiClientError(409, { error: "limit", code: "SAVED_LIST_LIMIT" }, null)),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("You can have up to 500 lists.");
  });
});
