import type { ImportPlacesInput } from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ParsedImport } from "@/lib/savedPlacesImport/types";

const state = vi.hoisted(() => ({
  parse: vi.fn(),
  resolve: vi.fn(),
  mutate: vi.fn(),
  select: vi.fn(),
}));
vi.mock("@/lib/savedPlacesImport", () => ({ parseImportFiles: state.parse }));
vi.mock("@/lib/savedPlacesImport/resolve", () => ({ resolveImportPlaces: state.resolve }));
vi.mock("@openmapx/core", async (original) => ({
  ...(await original<typeof import("@openmapx/core")>()),
  useSavedLists: () => ({
    data: [
      { id: "fav", name: "$favorites" },
      { id: "trip", name: "Trip" },
    ],
  }),
  useImportPlaces: () => ({ mutateAsync: state.mutate }),
  useSavedPlacesStore: (selector: (store: unknown) => unknown) =>
    selector({ selectList: state.select }),
}));
vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ get: () => ({ dataSources: [] }) }),
}));
vi.mock("@/components/ui/AttributionStrip", () => ({
  AttributionStrip: () => <div>Geocoder credit</div>,
}));

import { ImportPlacesDialog } from "./ImportPlacesDialog";

const files = [new File(["file"], "Trip.csv")];
const parsed = (): ParsedImport => ({
  lists: [
    {
      name: "Trip",
      source: "Trip.csv",
      places: [
        { name: "Exact", lat: 52, lng: 13, status: "exact" },
        { name: "Approx", lat: 53, lng: 14, status: "approximate" },
        { name: "Missing", status: "unresolved" },
      ],
    },
  ],
  errors: [{ file: "empty.gpx", code: "empty" }],
});
function mount(targetListId?: string) {
  const close = vi.fn();
  const rendered = render(
    <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
      <ImportPlacesDialog files={files} targetListId={targetListId} onClose={close} />
    </NextIntlClientProvider>,
  );
  return { close, ...rendered };
}
beforeEach(() => {
  vi.clearAllMocks();
  state.parse.mockResolvedValue(parsed());
  state.resolve.mockImplementation(async (lists) => lists);
  state.mutate.mockResolvedValue({
    listId: "created",
    name: "Trip",
    imported: 1,
    skippedDuplicates: 0,
  });
});
describe("import dialog", () => {
  it("reviews errors and unresolved names, excludes approximate places by default, imports and selects on finish", async () => {
    const { close } = mount();
    await screen.findByDisplayValue("Trip");
    expect(screen.getByText(/empty.gpx/)).toBeInTheDocument();
    expect(screen.getByLabelText(/Include approximate/)).not.toBeChecked();
    fireEvent.click(screen.getByText(/Not found/));
    expect(screen.getByText("Missing")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("List name"), { target: { value: "Holiday" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/Imported 1/);
    expect(state.mutate).toHaveBeenCalledWith({
      target: { name: "Holiday" },
      places: [{ name: "Exact", lat: 52, lng: 13 }],
    });
    expect(state.select).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(state.select).toHaveBeenCalledWith("created");
    expect(close).toHaveBeenCalled();
  });
  it("shows the new-list destination before the target selector is opened", async () => {
    mount();
    await screen.findByDisplayValue("Trip");
    expect(screen.getByRole("combobox")).toHaveTextContent("New list");
  });
  it("preselects the detail list and lets users include approximate places", async () => {
    mount("trip");
    await screen.findByDisplayValue("Trip");
    fireEvent.click(screen.getByLabelText(/Include approximate/));
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalled());
    expect(state.mutate.mock.calls[0][0]).toMatchObject({
      target: { listId: "trip" },
      places: [
        expect.objectContaining({ name: "Exact" }),
        expect.objectContaining({ name: "Approx" }),
      ],
    });
  });
  it("defaults recognized saved lists to an existing system list", async () => {
    const input = parsed();
    input.lists[0].systemList = "$favorites";
    state.parse.mockResolvedValue(input);
    mount();
    await screen.findByDisplayValue("Trip");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() =>
      expect(state.mutate).toHaveBeenCalledWith(
        expect.objectContaining({ target: { listId: "fav" } }),
      ),
    );
  });
  it("chunks more than 2000 places into the created list", async () => {
    const input = parsed();
    input.lists[0].places = Array.from({ length: 2001 }, (_, i) => ({
      name: `Place ${i}`,
      lat: 52,
      lng: 13,
      status: "exact",
    }));
    state.parse.mockResolvedValue(input);
    mount();
    await screen.findByDisplayValue("Trip");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await waitFor(() => expect(state.mutate).toHaveBeenCalledTimes(2));
    expect((state.mutate.mock.calls[0][0] as ImportPlacesInput).places).toHaveLength(2000);
    expect(state.mutate.mock.calls[1][0]).toMatchObject({
      target: { listId: "created" },
      places: [{ name: "Place 2000", lat: 52, lng: 13 }],
    });
  });
  it("shows the served geocoder credit for matched coordinates", async () => {
    const input = parsed();
    input.lists[0].places[0].status = "located";
    input.lists[0].places[0].geocoder = {
      id: "osm:node:1",
      label: "Exact",
      coordinates: [13, 52],
      type: "poi",
      confidence: 1,
      contributors: [{ sourceId: "test-source", name: "Test source" }],
    };
    state.parse.mockResolvedValue(input);
    mount();
    expect(await screen.findByText("Geocoder credit")).toBeInTheDocument();
  });
  it("aborts parsing/lookup when unmounted", async () => {
    state.resolve.mockImplementation(() => new Promise(() => {}));
    const { unmount } = mount();
    await waitFor(() => expect(state.resolve).toHaveBeenCalled());
    const signal = (state.resolve.mock.calls[0][1] as { signal: AbortSignal }).signal;
    unmount();
    expect(signal.aborted).toBe(true);
  });
  it("reports a partial import if a later chunk fails", async () => {
    const input = parsed();
    input.lists[0].places = Array.from({ length: 2001 }, (_, i) => ({
      name: `Place ${i}`,
      lat: 52,
      lng: 13,
      status: "exact",
    }));
    state.parse.mockResolvedValue(input);
    let calls = 0;
    state.mutate.mockImplementation(async () => {
      if (calls++ > 0) throw new Error("Failed");
      return { listId: "created", name: "Trip", imported: 2000, skippedDuplicates: 0 };
    });
    mount();
    await screen.findByDisplayValue("Trip");
    fireEvent.click(screen.getByRole("button", { name: "Import" }));
    await screen.findByText(/Imported 2000/);
    expect(screen.getByText(/could not be imported/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(state.select).toHaveBeenCalledWith("created");
  });
});
