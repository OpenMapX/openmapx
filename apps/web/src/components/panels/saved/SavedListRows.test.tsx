import {
  apiClient,
  createPlace,
  type SavedPlace,
  useMapStore,
  useMergedPlace,
  usePlaceDetails,
} from "@openmapx/core";
import { en } from "@openmapx/i18n";
import { onlineManager, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { savedPlaceToPlace } from "@/lib/openSavedPlace";
import { SavedListRows } from "./SavedListRows";

vi.mock("@openmapx/integration-framework/react", () => ({
  useIntegrationRegistry: () => ({ findDataSource: () => undefined }),
}));

const getMock = vi.spyOn(apiClient, "get");
const observers: Array<{ callback: IntersectionObserverCallback; targets: Element[] }> = [];
const saved = (id: string, placeId: string | null = null): SavedPlace => ({
  id,
  placeId,
  listId: "list",
  name: `Landmark ${id}`,
  address: "Public square",
  lat: 51,
  lng: 8,
  note: null,
  sortOrder: 0,
  createdAt: "2026-10-20T00:00:00Z",
  fieldContributors: {
    name: [{ sourceId: "saved", name: "Saved publisher" }],
    lat: [{ sourceId: "coords", name: "Coordinate publisher" }],
    lng: [],
  },
});
const resolved = createPlace({
  primaryScheme: "osm",
  ids: { osm: "node/1" },
  name: "Resolved title",
  address: "Resolved street",
  coordinates: [8.1, 51.1],
  category: "bare_rock",
  contributors: [{ sourceId: "osm", name: "OpenStreetMap" }],
  photos: [
    {
      url: "https://example.org/landmark.jpg",
      source: "commons",
      author: "Public photographer",
      licensing: {
        version: 1,
        bindings: [
          {
            scope: "imagery",
            subject: "Photo",
            license: { kind: "spdx", expression: "CC-BY-SA-4.0" },
          },
        ],
      },
    },
  ],
});

function show(ids?: string[]) {
  act(() => {
    for (const observer of observers)
      observer.callback(
        observer.targets.map((target) => ({
          target,
          isIntersecting: ids
            ? ids.includes((target as HTMLElement).dataset.savedPlaceId ?? "")
            : true,
        })) as IntersectionObserverEntry[],
        {} as IntersectionObserver,
      );
  });
}
function setup(
  places: SavedPlace[],
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const select = vi.fn();
  const view = render(
    <QueryClientProvider client={client}>
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Berlin">
        <SavedListRows
          places={places}
          onSelect={select}
          renderNote={(place) => <button type="button">{place.note ?? "+ Note"}</button>}
        />
      </NextIntlClientProvider>
    </QueryClientProvider>,
  );
  return { ...view, client, select };
}
beforeEach(() => {
  onlineManager.setOnline(true);
  observers.length = 0;
  useMapStore.setState({ userLocation: null });
  getMock.mockReset().mockResolvedValue(resolved);
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      current: (typeof observers)[number];
      constructor(callback: IntersectionObserverCallback) {
        this.current = { callback, targets: [] };
        observers.push(this.current);
      }
      observe(target: Element) {
        this.current.targets.push(target);
      }
      disconnect() {
        this.current.targets = [];
      }
    },
  );
});

describe("saved result rows", () => {
  it("keeps notes outside the result button and selects the saved record", () => {
    const place = { ...saved("one"), note: "Visit in daylight" };
    const { select } = setup([place, saved("two")]);
    expect(
      screen.getByRole("button", { name: "Visit in daylight" }).closest("button button"),
    ).toBeNull();
    expect(screen.getByRole("button", { name: "+ Note" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Landmark one/ }));
    expect(select).toHaveBeenCalledWith(place);
  });
  it("does not fetch offscreen rows and shows a credited photo when a saved identity resolves", async () => {
    setup([saved("one"), saved("two")]);
    expect(apiClient.get).not.toHaveBeenCalled();
    show(["one"]);
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(
      "/api/places/saved%3Aone",
      expect.objectContaining({ name: "Landmark one", lat: "51", lng: "8", hasAddress: "1" }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(screen.getByText("Public photographer")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /4\.0/ })).toBeInTheDocument();
    expect(screen.getByText("Landmark one")).toBeInTheDocument();
    expect(screen.getByText("Bare Rock")).toBeInTheDocument();
    expect(screen.getAllByText("Saved publisher").length).toBeGreaterThan(0);
  });
  it.each(["absent", "error", "broken"])(
    "uses the search no-photo layout for %s photos",
    async (mode) => {
      if (mode === "error") getMock.mockRejectedValue(new Error("Unavailable"));
      else getMock.mockResolvedValue(mode === "absent" ? { ...resolved, photos: [] } : resolved);
      setup([saved("one", "osm:node/1")]);
      show();
      await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(1));
      if (mode === "broken") {
        await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
        fireEvent.error(document.querySelector("img") as HTMLImageElement);
      }
      await waitFor(() => expect(document.querySelector(".MuiSkeleton-root")).toBeNull());
      expect(document.querySelector("img")).toBeNull();
      expect(screen.getByRole("button", { name: /Landmark one/ })).toBeInTheDocument();
    },
  );
  it("credits stored coordinates for distance and resolved fields independently", async () => {
    useMapStore.setState({ userLocation: [8, 50.99] });
    setup([saved("one")]);
    show();
    await waitFor(() => expect(screen.getByText("Bare Rock")).toBeInTheDocument());
    expect(screen.getByText("Coordinate publisher")).toBeInTheDocument();
    expect(screen.getByText("Saved publisher")).toBeInTheDocument();
    expect(screen.getByText(/1.1.*km/)).toBeInTheDocument();
    expect(screen.getByText("OpenStreetMap")).toBeInTheDocument();
    expect(screen.queryByText("Resolved title")).toBeNull();
    expect(screen.queryByText("Resolved street")).toBeNull();
  });

  it("cancels rows leaving the viewport and leaves the other hundred rows unfetched", async () => {
    getMock.mockImplementation(() => new Promise(() => {}));
    const view = setup(Array.from({ length: 105 }, (_, i) => saved(String(i))));
    expect(apiClient.get).not.toHaveBeenCalled();
    show(["0", "1", "2", "3"]);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(3));
    const signals = getMock.mock.calls.map(
      (call) => (call[2] as { signal?: AbortSignal } | undefined)?.signal,
    );
    show(["104"]);
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(4));
    expect(signals.every((signal) => signal?.aborted)).toBe(true);
    expect(apiClient.get).toHaveBeenLastCalledWith(
      "/api/places/saved%3A104",
      expect.any(Object),
      expect.any(Object),
    );
    view.unmount();
    expect(
      (getMock.mock.calls[3][2] as { signal?: AbortSignal } | undefined)?.signal?.aborted,
    ).toBe(true);
  });

  it("keeps offline saved names visible, reads cached rows past paused work, and resumes online", async () => {
    const first = setup([saved("cached")]);
    show(["cached"]);
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    first.unmount();
    observers.length = 0;
    getMock.mockClear();
    onlineManager.setOnline(false);
    setup([saved("0"), saved("1"), saved("2"), saved("cached")], first.client);
    show();
    expect(screen.getByText("Landmark 0")).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("img")).not.toBeNull());
    expect(apiClient.get).not.toHaveBeenCalled();
    act(() => onlineManager.setOnline(true));
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(3));
  });

  it("neutralizes opening verdicts at expiry without another request", async () => {
    const now = Date.now();
    getMock.mockResolvedValue({
      ...resolved,
      openingHours: "Mo-Su 10:00-18:00",
      openingHoursInfo: {
        status: { isOpen: true },
        validUntil: new Date(now + 1000).toISOString(),
        isAlwaysOpen: false,
        weekBitmap: "",
      },
    });
    setup([saved("hours")]);
    show();
    await waitFor(() => expect(screen.getByText("Open")).toBeInTheDocument());
    const clock = vi.spyOn(Date, "now").mockReturnValue(now + 2000);
    try {
      fireEvent(window, new Event("focus"));
      expect(screen.queryByText("Open")).toBeNull();
      expect(screen.getByText("Opening hours unconfirmed")).toBeInTheDocument();
      expect(apiClient.get).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("uses the card's reverse-geocoding cache for coordinate identities", async () => {
    getMock.mockResolvedValue({
      address: "Public coordinate address",
      contributors: [{ sourceId: "reverse", name: "Reverse supplier" }],
    });
    const place = { ...saved("coordinate", "coordinate:8,51"), address: null };
    const view = setup([place]);
    show();
    await waitFor(() => expect(screen.getByText("Public coordinate address")).toBeInTheDocument());
    expect(apiClient.get).toHaveBeenCalledTimes(1);
    expect(apiClient.get).toHaveBeenCalledWith(
      "/api/integrations/geocoding/geocode/reverse",
      { lat: "51", lng: "8" },
      expect.any(Object),
    );
    expect(screen.getByText("Reverse supplier")).toBeInTheDocument();
    expect(document.querySelector("img")).toBeNull();
    function CoordinateCard() {
      const { place: merged } = useMergedPlace(savedPlaceToPlace(place));
      return <span>{merged?.address}</span>;
    }
    view.rerender(
      <QueryClientProvider client={view.client}>
        <CoordinateCard />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Public coordinate address")).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(1);
  });

  it("limits concurrent details to three and reuses the place-card query cache", async () => {
    const releases: Array<() => void> = [];
    getMock.mockImplementation(
      () => new Promise((resolve) => releases.push(() => resolve(resolved))),
    );
    const { client, rerender } = setup(Array.from({ length: 8 }, (_, i) => saved(String(i))));
    show();
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(3));
    await act(async () => {
      for (const resolve of releases.splice(0)) resolve();
    });
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(6));
    await act(async () => {
      for (const resolve of releases.splice(0)) resolve();
    });
    await waitFor(() => expect(apiClient.get).toHaveBeenCalledTimes(8));
    await act(async () => {
      for (const resolve of releases.splice(0)) resolve();
    });
    function Card() {
      const place = savedPlaceToPlace(saved("0"));
      const query = usePlaceDetails(
        place.id,
        place.coordinates,
        place.name,
        undefined,
        Boolean(place.address),
      );
      return <span>{query.data?.photos?.[0]?.author}</span>;
    }
    rerender(
      <QueryClientProvider client={client}>
        <Card />
      </QueryClientProvider>,
    );
    expect(screen.getByText("Public photographer")).toBeInTheDocument();
    expect(apiClient.get).toHaveBeenCalledTimes(8);
  });
});
