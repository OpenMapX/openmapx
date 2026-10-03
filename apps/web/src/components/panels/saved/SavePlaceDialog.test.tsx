import {
  API_ENDPOINTS,
  apiClient,
  createPlace,
  type SavedList,
  type SavedPlace,
} from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, userEvent, waitFor } from "@/test";

vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({ data: { user: { id: "u1" } } }),
}));
vi.mock("next-intl", async () => (await import("@/test/intl")).mockNextIntl());

import { SavePlaceDialog } from "./SavePlaceDialog";

const place = createPlace({
  primaryScheme: "osm",
  ids: { osm: "p1" },
  name: "Place",
  address: "",
  coordinates: [8, 50],
});
const row = {
  id: "sp1",
  listId: "l1",
  name: "Place",
  placeId: place.id,
  lat: 50,
  lng: 8,
  address: null,
  note: null,
  sortOrder: 0,
  createdAt: "2026-10-03T00:00:00Z",
} as SavedPlace;
const clients: QueryClient[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  clients.splice(0).forEach((c) => {
    c.clear();
  });
});
function setup(initial = false) {
  const rows: SavedPlace[] = initial ? [row] : [];
  const lists = [{ id: "l1", name: "Trip", icon: null, isPrivate: true }] as SavedList[];
  let finishCreate: () => void = () => {};
  let rejectCreate: (error: Error) => void = () => {};
  let rejectPost: (error: Error) => void = () => {};
  let finishPost: () => void = () => {};
  let finishDelete: () => void = () => {};
  const post = vi.spyOn(apiClient, "post").mockImplementation((url, data) => {
    if (url === API_ENDPOINTS.savedLists)
      return new Promise((resolve, reject) => {
        rejectCreate = reject;
        finishCreate = () => {
          const list = {
            id: "l2",
            name: (data as { name: string }).name,
            icon: null,
            isPrivate: true,
          } as SavedList;
          lists.push(list);
          resolve(list);
        };
      });
    return new Promise((resolve, reject) => {
      rejectPost = reject;
      finishPost = () => {
        const saved = {
          ...row,
          ...(data as object),
          listId: String(url).split("/").at(-2),
          id: "sp1",
        } as SavedPlace;
        if (!rows.some((existing) => existing.id === saved.id)) rows.push(saved);
        resolve(saved);
      };
    });
  });
  const remove = vi.spyOn(apiClient, "delete").mockImplementation(async () => {
    rows.splice(0);
    return {};
  });
  const read = async (url: unknown, params?: unknown) => {
    if (url === API_ENDPOINTS.savedLists)
      return {
        lists: lists.map((list) => ({
          ...list,
          placeCount: rows.filter((row) => row.listId === list.id).length,
        })),
      };
    if (url === API_ENDPOINTS.savedCheck)
      return {
        listIds: rows
          .filter((row) => row.placeId === (params as { placeId: string }).placeId)
          .map((row) => row.listId),
      };
    return { places: [...rows] };
  };
  const get = vi.spyOn(apiClient, "get").mockImplementation(read);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  const view = render(
    <QueryClientProvider client={client}>
      <SavePlaceDialog open onClose={() => {}} place={place} />
    </QueryClientProvider>,
  );
  return {
    rows,
    lists,
    get,
    read,
    finishCreate: () => finishCreate(),
    rejectCreate: () => rejectCreate(new Error("creation failed")),
    rejectPost: () => rejectPost(new Error("save failed")),
    post,
    remove,
    client,
    view,
    finishPost: () => finishPost(),
    deferDelete: () => {
      remove.mockImplementation(
        () =>
          new Promise((resolve) => {
            finishDelete = () => {
              rows.splice(0);
              resolve({});
            };
          }),
      );
    },
    finishDelete: () => finishDelete(),
  };
}
describe("saved-place membership intent", () => {
  it("accepts later server membership changes after a save finishes", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]));
    await userEvent.click(screen.getByText("Trip"));
    // The server commits before the POST acknowledgement arrives. A refetch
    // sees that membership while the local reconciliation is still running.
    fixture.rows.push(row);
    await act(async () => fixture.client.invalidateQueries({ queryKey: ["savedCheck", place.id] }));
    await waitFor(() =>
      expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual(["l1"]),
    );
    await act(async () => fixture.finishPost());
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    await act(async () => fixture.client.invalidateQueries({ queryKey: ["savedCheck", place.id] }));
    fixture.rows.splice(0);
    await act(async () => fixture.client.invalidateQueries({ queryKey: ["savedCheck", place.id] }));
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
  });
  it.each([2, 3])(
    "honours the final intent after %i clicks during a pending save",
    async (clicks) => {
      const fixture = setup();
      await screen.findByText("Trip");
      await waitFor(() =>
        expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]),
      );
      for (let i = 0; i < clicks; i++) await userEvent.click(screen.getByText("Trip"));
      expect(fixture.post).toHaveBeenCalledTimes(1);
      await act(async () => fixture.finishPost());
      await waitFor(() => expect(fixture.rows).toHaveLength(clicks === 2 ? 0 : 1));
      await waitFor(() => {
        if (clicks === 2) expect(screen.getByRole("checkbox")).not.toBeChecked();
        else expect(screen.getByRole("checkbox")).toBeChecked();
      });
    },
  );
  it("saves again when the user reselects a list during a pending delete", async () => {
    const fixture = setup(true);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    fixture.deferDelete();
    await userEvent.click(screen.getByText("Trip"));
    await waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(1));
    await userEvent.click(screen.getByText("Trip"));
    await act(async () => fixture.finishDelete());
    await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    await act(async () => fixture.finishPost());
    await waitFor(() => expect(fixture.rows).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  });
  it("restores server membership when a save fails", async () => {
    const fixture = setup();
    fixture.post.mockRejectedValue(new Error("offline"));
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]));
    await userEvent.click(screen.getByText("Trip"));
    await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole("checkbox")).not.toBeChecked());
    expect(fixture.rows).toHaveLength(0);
  });
  it("finishes an old place's pending unsave without checking a newly displayed place", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]));
    await userEvent.click(screen.getByText("Trip"));
    await userEvent.click(screen.getByText("Trip"));
    const other = createPlace({
      primaryScheme: "osm",
      ids: { osm: "p2" },
      name: "Other",
      address: "",
      coordinates: [9, 51],
    });
    fixture.view.rerender(
      <QueryClientProvider client={fixture.client}>
        <SavePlaceDialog open onClose={() => {}} place={other} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", other.id])).toEqual([]));
    await act(async () => fixture.finishPost());
    await waitFor(() => expect(fixture.rows).toHaveLength(0));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
  });
  it("completes the requested unsave even after the dialog unmounts", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]));
    await userEvent.click(screen.getByText("Trip"));
    await userEvent.click(screen.getByText("Trip"));
    fixture.view.unmount();
    await act(async () => fixture.finishPost());
    await waitFor(() => expect(fixture.rows).toHaveLength(0));
    expect(fixture.remove).toHaveBeenCalledTimes(1);
  });
});

const other = createPlace({
  primaryScheme: "osm",
  ids: { osm: "p2" },
  name: "Other",
  address: "",
  coordinates: [9, 51],
});
async function startCreation() {
  await userEvent.click(screen.getByRole("button", { name: "saved.createNewList" }));
  await userEvent.type(screen.getByRole("textbox"), "New list{Enter}");
}
function show(fixture: ReturnType<typeof setup>, open = true, displayed = place) {
  fixture.view.rerender(
    <QueryClientProvider client={fixture.client}>
      <SavePlaceDialog open={open} onClose={() => {}} place={displayed} />
    </QueryClientProvider>,
  );
}
async function reopen(fixture: ReturnType<typeof setup>) {
  show(fixture, false);
  await waitFor(() => expect(screen.queryByRole("checkbox")).toBeNull());
  show(fixture);
}
describe("saved-place failure and creation reconciliation", () => {
  it.each(["remove", "lookup"])(
    "restores membership after failed %s and reopening",
    async (failure) => {
      const fixture = setup(true);
      await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
      let rejectRemoval: (error: Error) => void = () => {};
      if (failure === "remove")
        fixture.remove.mockImplementation(
          () =>
            new Promise((_resolve, reject) => {
              rejectRemoval = reject;
            }),
        );
      else {
        const original = fixture.read;
        fixture.get.mockImplementation((url, params) =>
          String(url).endsWith("/places")
            ? Promise.reject(new Error("lookup failed"))
            : original(url, params),
        );
      }
      await userEvent.click(screen.getByText("Trip"));
      if (failure === "remove") {
        await waitFor(() => expect(fixture.remove).toHaveBeenCalledTimes(1));
        expect(screen.getByRole("checkbox")).not.toBeChecked();
        await act(async () => rejectRemoval(new Error("offline")));
      }
      await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
      expect(fixture.rows).toEqual([row]);
      expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual(["l1"]);
      if (failure === "lookup") expect(fixture.remove).not.toHaveBeenCalled();
      await reopen(fixture);
      await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
    },
  );
  it.each(["success", "creation failure", "save failure", "switch place"])(
    "binds creation to its requested place: %s",
    async (outcome) => {
      const fixture = setup();
      await waitFor(() =>
        expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]),
      );
      await startCreation();
      await waitFor(() =>
        expect(fixture.post).toHaveBeenCalledWith(API_ENDPOINTS.savedLists, { name: "New list" }),
      );
      if (outcome === "creation failure") {
        await act(async () => fixture.rejectCreate());
        expect(fixture.lists).toHaveLength(1);
        expect(fixture.rows).toHaveLength(0);
        expect(fixture.post).toHaveBeenCalledTimes(1);
        await reopen(fixture);
        expect(screen.getByRole("checkbox")).not.toBeChecked();
        return;
      }
      if (outcome === "switch place") {
        show(fixture, true, other);
        await waitFor(() =>
          expect(fixture.client.getQueryData(["savedCheck", other.id])).toEqual([]),
        );
      }
      await act(async () => fixture.finishCreate());
      await waitFor(() => expect(fixture.post).toHaveBeenCalledTimes(2));
      expect(fixture.post).toHaveBeenLastCalledWith(
        `${API_ENDPOINTS.savedLists}/l2/places`,
        expect.objectContaining({ placeId: place.id, name: place.name, lat: 50, lng: 8 }),
      );
      await act(async () => {
        if (outcome === "save failure") fixture.rejectPost();
        else fixture.finishPost();
      });
      await screen.findByText("New list");
      await waitFor(() =>
        expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual(
          outcome === "save failure" ? [] : ["l2"],
        ),
      );
      expect(fixture.rows).toHaveLength(outcome === "save failure" ? 0 : 1);
      if (outcome === "switch place") {
        expect(fixture.rows[0].placeId).toBe(place.id);
        expect(fixture.client.getQueryData(["savedCheck", other.id])).toEqual([]);
        expect(
          screen
            .getAllByRole("checkbox")
            .every((checkbox) => !(checkbox as HTMLInputElement).checked),
        ).toBe(true);
      }
      await reopen(fixture);
      await waitFor(() => {
        if (outcome === "save failure")
          expect(screen.getAllByRole("checkbox")[1]).not.toBeChecked();
        else expect(screen.getAllByRole("checkbox")[1]).toBeChecked();
      });
    },
  );
  it("discards a stale membership read captured before the final save", async () => {
    const fixture = setup();
    await waitFor(() => expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual([]));
    let finishRead!: () => void;
    const original = fixture.read;
    fixture.get.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishRead = () => resolve({ listIds: [] });
        }),
    );
    act(() => {
      void fixture.client.invalidateQueries({ queryKey: ["savedCheck", place.id] });
    });
    await userEvent.click(screen.getByText("Trip"));
    fixture.get.mockImplementation(original);
    await act(async () => fixture.finishPost());
    await waitFor(() =>
      expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual(["l1"]),
    );
    await act(async () => finishRead());
    expect(fixture.client.getQueryData(["savedCheck", place.id])).toEqual(["l1"]);
    expect(screen.getByRole("checkbox")).toBeChecked();
    expect(fixture.rows).toEqual([row]);
    await reopen(fixture);
    await waitFor(() => expect(screen.getByRole("checkbox")).toBeChecked());
  });
});
