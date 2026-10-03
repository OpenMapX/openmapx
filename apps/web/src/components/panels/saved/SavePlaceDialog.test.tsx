import { API_ENDPOINTS, apiClient, createPlace, type SavedPlace } from "@openmapx/core";
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
  let finishPost: () => void = () => {};
  let finishDelete: () => void = () => {};
  const post = vi.spyOn(apiClient, "post").mockImplementation(
    () =>
      new Promise((resolve) => {
        finishPost = () => {
          if (!rows.some((existing) => existing.id === row.id)) rows.push(row);
          resolve(row);
        };
      }),
  );
  const remove = vi.spyOn(apiClient, "delete").mockImplementation(async () => {
    rows.splice(0);
    return {};
  });
  vi.spyOn(apiClient, "get").mockImplementation(async (url, params) => {
    if (url === API_ENDPOINTS.savedLists)
      return {
        lists: [{ id: "l1", name: "Trip", icon: null, isPrivate: true, placeCount: rows.length }],
      };
    if (url === API_ENDPOINTS.savedCheck)
      return {
        listIds: rows.some((row) => row.placeId === (params as { placeId: string }).placeId)
          ? ["l1"]
          : [],
      };
    return { places: [...rows] };
  });
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
