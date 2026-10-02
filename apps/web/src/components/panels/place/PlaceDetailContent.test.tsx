import { createPlace, type Place, usePlaceStore } from "@openmapx/core";
import type { MergedDeparture } from "@openmapx/mobility-core/transit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactNode } from "react";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DetailChromeContext } from "../DetailShell";
import { MobileSheetContext } from "../sheet/sheetState";
import { PlaceDetailContent } from "./PlaceDetailContent";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@openmapx/mangrove-react", () => ({
  useReviewAggregate: () => ({ data: undefined, isLoading: false }),
}));

// useBrandDetail is the only hook here that hits the network; stub it so
// the brand-header tests below control `logoFile` deterministically instead
// of depending on a real fetch. All other @openmapx/core exports pass through
// untouched — in particular firstBrandIdentity, which PlaceDetailContent
// itself now calls to resolve a place's brand identity from its osmTags.
const mockUseBrandDetail = vi.fn();
vi.mock("@openmapx/core", async () => {
  const actual = await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core");
  return {
    ...actual,
    useBrandDetail: (qid: string | null) => mockUseBrandDetail(qid),
  };
});

beforeEach(() => {
  mockUseBrandDetail.mockReturnValue({ data: undefined });
});

vi.mock("./PlacePhotoGallery", () => ({
  PlacePhotoGallery: () => null,
}));

vi.mock("../transit/TripDetailView", () => ({
  TripDetailView: () => <span>Selected trip</span>,
}));
vi.mock("../transit/LineDetail", () => ({
  LineDetail: () => <span>Selected line</span>,
}));
vi.mock("../transit/StopInfrastructureSection", () => ({ StopInfrastructureSection: () => null }));
vi.mock("../transit/PlaceTransitSection", () => ({
  PlaceTransitSection: ({
    onOpenLineDetail,
  }: {
    onOpenLineDetail: (route: { id: string }) => void;
  }) => (
    <button type="button" onClick={() => onOpenLineDetail({ id: "line" })}>
      Open line
    </button>
  ),
}));

// Lets individual tests drive `useSheetSentinel`'s `passed` flag directly
// instead of depending on a real IntersectionObserver callback, which jsdom
// can't fire deterministically.
const sentinelState = { passed: false };

vi.mock("../sheet/sheetState", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../sheet/sheetState")>();
  return {
    ...actual,
    useSheetSentinel: () => ({ ref: () => {}, passed: sentinelState.passed }),
  };
});

// jsdom has no IntersectionObserver — useSheetSentinel (used for the docked
// action bar) needs one to exist to observe its ref.
class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

const place = {
  id: "p1",
  name: "Test Place",
  coordinates: [6.0839, 50.7753],
} as unknown as Place;

function renderAtDetent(detent: "peek" | "mid" | "full", selectedPlace = place) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileSheetContext.Provider
        value={{ detent, isExpanded: detent === "full", inSheet: true, snapTo: () => {} }}
      >
        <PlaceDetailContent place={selectedPlace} isLoading={false} />
      </MobileSheetContext.Provider>
    </QueryClientProvider>,
  );
}

describe("selected detail enrichment", () => {
  it.each(["trip", "line"])(
    "preserves the visible %s across identity promotion and resets it on reselection",
    (action) => {
      const provisional = createPlace({
        primaryScheme: "db",
        ids: { db: "A" },
        name: "Station A",
        address: "",
        coordinates: [8, 50],
        rawCategory: "transit_stop",
      });
      const enriched = createPlace({
        primaryScheme: "osm",
        ids: { osm: "node/1", db: "A" },
        name: "Station A",
        address: "",
        coordinates: [8, 50],
        rawCategory: "transit_stop",
      });
      usePlaceStore.getState().setSelectedPlace(provisional);
      function SelectedDetail() {
        const selected = usePlaceStore((state) => state.selectedPlace);
        return selected && <PlaceDetailContent place={selected} isLoading={false} />;
      }
      const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      const view = render(
        <QueryClientProvider client={client}>
          <SelectedDetail />
        </QueryClientProvider>,
      );
      if (action === "trip") {
        act(() =>
          usePlaceStore.getState().setActiveTripDep({ route: { id: "line" } } as MergedDeparture),
        );
      } else {
        fireEvent.click(screen.getByText("Open line"));
      }
      const label = action === "trip" ? "Selected trip" : "Selected line";
      expect(screen.getByText(label)).toBeVisible();
      act(() =>
        usePlaceStore
          .getState()
          .enrichSelectedPlace(usePlaceStore.getState().selectionRevision, enriched),
      );
      expect(screen.getByText(label)).toBeVisible();
      act(() => usePlaceStore.getState().setSelectedPlace(enriched));
      expect(screen.queryByText(label)).toBeNull();
      view.unmount();
      usePlaceStore.getState().setSelectedPlace(null);
    },
  );
});

describe("PlaceDetailContent per detent", () => {
  it("keeps the title at peek", () => {
    renderAtDetent("peek");
    expect(screen.getByText("Test Place")).toBeDefined();
  });

  it("drops the rating row at peek", () => {
    renderAtDetent("peek", { ...place, rating: 4.5, reviewCount: 12 } as Place);
    expect(screen.queryByTestId("place-rating-row")).toBeNull();
  });

  it("keeps one category and known opening summary before actions at peek", () => {
    const { container } = renderAtDetent("peek", {
      ...place,
      name: "A very long restaurant name that must leave room for the close button",
      category: "A very long restaurant category that needs truncation",
      openingHoursInfo: {
        status: {
          isOpen: true,
          nextChange: { kind: "closes", at: "19:00", weekday: 6, day: "today" },
        },
      },
    } as Place);
    const peek = container.querySelector("[data-omx-peek]") as HTMLElement;
    const summary = within(peek).getByTestId("place-peek-summary");
    expect(summary.textContent).toBe(
      "A very long restaurant category that needs truncation · open · closesAt",
    );
    expect(within(peek).getAllByTestId("place-peek-summary")).toHaveLength(1);
    expect(
      summary.compareDocumentPosition(within(peek).getByText("directions")) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      within(peek).getByText(
        "A very long restaurant name that must leave room for the close button",
      ),
    ).toBeVisible();
    expect(within(peek).getByText("savePlace")).toBeVisible();
    expect(within(peek).getByText("share")).toBeVisible();
  });

  it("keeps unknown hours neutral and absent hours without a verdict at peek", () => {
    const unknown = renderAtDetent("peek", {
      ...place,
      category: "Cafe",
      isOpen: false,
      openingHoursInfo: { status: { isOpen: false, isUnknown: true, text: "by appointment" } },
    } as Place);
    expect(screen.getByTestId("place-peek-summary").textContent).toBe("Cafe · unconfirmed");
    unknown.unmount();

    renderAtDetent("peek", { ...place, category: "Cafe", isOpen: false } as Place);
    expect(screen.getByTestId("place-peek-summary").textContent).toBe("Cafe");
  });

  it("keeps the compact line out of the expanded view", () => {
    renderAtDetent("mid", {
      ...place,
      category: "Restaurant",
      openingHoursInfo: { status: { isOpen: true } },
    } as Place);
    expect(screen.queryByTestId("place-peek-summary")).toBeNull();
    expect(screen.getByText("Restaurant")).toBeVisible();
  });

  it("restores the rating row at mid", () => {
    renderAtDetent("mid", { ...place, rating: 4.5, reviewCount: 12 } as Place);
    expect(within(screen.getByTestId("place-rating-row")).getByText("4.5")).toBeVisible();
  });

  it("shows a known opening state beside category below the title and before actions", () => {
    renderAtDetent("mid", {
      ...place,
      category: "Restaurant",
      rating: 4.5,
      reviewCount: 12,
      openingHoursInfo: { status: { isOpen: true } },
    } as Place);
    const meta = screen.getByTestId("place-rating-row");
    const category = screen.getByText("Restaurant");
    expect(category).toBeVisible();
    expect(
      within(document.querySelector("[data-omx-peek]") as HTMLElement).getByText("open"),
    ).toBeVisible();
    expect(meta.contains(category)).toBe(false);
    const actions = screen.getByText("directions");
    expect(
      category.compareDocumentPosition(actions) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("keeps unknown hours neutral and omits a verdict when status is absent", () => {
    const { rerender } = renderAtDetent("mid", {
      ...place,
      category: "Cafe",
      isOpen: false,
      openingHoursInfo: { status: { isOpen: false, isUnknown: true, text: "by appointment" } },
    } as Place);
    const peek = document.querySelector("[data-omx-peek]") as HTMLElement;
    expect(within(peek).getByText("unconfirmed")).toBeVisible();
    expect(within(peek).queryByText("closed")).toBeNull();
    rerender(
      <QueryClientProvider client={new QueryClient()}>
        <MobileSheetContext.Provider
          value={{ detent: "mid", isExpanded: false, inSheet: true, snapTo: () => {} }}
        >
          <PlaceDetailContent
            place={{ ...place, category: "Cafe", isOpen: false } as Place}
            isLoading={false}
          />
        </MobileSheetContext.Provider>
      </QueryClientProvider>,
    );
    expect(within(peek).queryByText("closed")).toBeNull();
    expect(within(peek).queryByText("unconfirmed")).toBeNull();
  });
});

const placeWithPhoto = {
  id: "p2",
  name: "Photo Place",
  coordinates: [6.0839, 50.7753],
  photos: [{ url: "https://example.com/photo.jpg" }],
} as unknown as Place;

function renderPhotoPlaceAtDetent(detent: "peek" | "mid" | "full") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileSheetContext.Provider
        value={{ detent, isExpanded: detent === "full", inSheet: true, snapTo: () => {} }}
      >
        <PlaceDetailContent place={placeWithPhoto} isLoading={false} />
      </MobileSheetContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PlaceDetailContent photo hero per detent", () => {
  it("hides the photo hero at peek so the title/chips stay visible", () => {
    renderPhotoPlaceAtDetent("peek");
    expect(screen.queryByTestId("place-photo-hero")).toBeNull();
    expect(screen.getByText("Photo Place")).toBeDefined();
  });

  it("shows the photo hero at mid", () => {
    renderPhotoPlaceAtDetent("mid");
    expect(screen.getByTestId("place-photo-hero")).toBeDefined();
  });
});

// Harness for the mobile-sheet chrome bridge (useDetailChrome / DetailChromeContext):
// captures whatever PlaceDetailContent registers as the pinned header / docked
// footer into local state and renders both, so assertions can query them like
// any other part of the tree. Both live under the same QueryClientProvider as
// the main content, since the docked footer renders PlaceActionButtons, which
// needs it.
function ChromeHarness({
  detent,
  isExpanded,
}: {
  detent: "peek" | "mid" | "full";
  isExpanded: boolean;
}) {
  const [header, setHeader] = useState<ReactNode>(null);
  const [footer, setFooter] = useState<ReactNode>(null);
  return (
    <DetailChromeContext.Provider value={{ setHeader, setFooter }}>
      <div data-testid="chrome-header">{header}</div>
      <MobileSheetContext.Provider value={{ detent, isExpanded, inSheet: true, snapTo: () => {} }}>
        <PlaceDetailContent place={place} isLoading={false} />
      </MobileSheetContext.Provider>
      <div data-testid="chrome-footer">{footer}</div>
    </DetailChromeContext.Provider>
  );
}

function renderChrome(detent: "peek" | "mid" | "full", isExpanded: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const utils = render(
    <QueryClientProvider client={client}>
      <ChromeHarness detent={detent} isExpanded={isExpanded} />
    </QueryClientProvider>,
  );
  return {
    ...utils,
    rerenderWith: (nextDetent: "peek" | "mid" | "full", nextIsExpanded: boolean) =>
      utils.rerender(
        <QueryClientProvider client={client}>
          <ChromeHarness detent={nextDetent} isExpanded={nextIsExpanded} />
        </QueryClientProvider>,
      ),
  };
}

describe("PlaceDetailContent mobile-sheet chrome bridge", () => {
  it("does not register a pinned header while the sheet is not expanded", () => {
    renderChrome("mid", false);
    expect(within(screen.getByTestId("chrome-header")).queryByText("Test Place")).toBeNull();
  });

  // Expansion alone is not enough: at the top of an expanded sheet the real
  // title is still on screen, so a pinned copy would repeat the name and its
  // band would push the photo hero off the sheet's top edge.
  it("does not register a pinned header while the real title is still visible", () => {
    sentinelState.passed = false;
    renderChrome("full", true);
    expect(within(screen.getByTestId("chrome-header")).queryByText("Test Place")).toBeNull();
  });

  it("registers a pinned header once the real title has scrolled away", () => {
    sentinelState.passed = true;
    renderChrome("full", true);
    expect(within(screen.getByTestId("chrome-header")).getByText("Test Place")).toBeDefined();
    sentinelState.passed = false;
  });

  it("unregisters the pinned header when the sheet collapses back", () => {
    sentinelState.passed = true;
    const { rerenderWith } = renderChrome("full", true);
    expect(within(screen.getByTestId("chrome-header")).getByText("Test Place")).toBeDefined();

    rerenderWith("mid", false);
    expect(within(screen.getByTestId("chrome-header")).queryByText("Test Place")).toBeNull();
    sentinelState.passed = false;
  });

  it("keeps the docked footer empty while the inline chips are still visible", () => {
    sentinelState.passed = false;
    renderChrome("full", true);
    expect(within(screen.getByTestId("chrome-footer")).queryByText("directions")).toBeNull();
  });

  it("docks the action bar once the sentinel reports the chips scrolled away", () => {
    sentinelState.passed = true;
    renderChrome("full", true);
    expect(within(screen.getByTestId("chrome-footer")).getByText("directions")).toBeDefined();
    sentinelState.passed = false;
  });

  // The inline row stays mounted behind the docked copy, so without `inert`
  // every action would be announced and tabbed to twice.
  it("takes the inline chips out of the tree while the docked copy is up", () => {
    sentinelState.passed = true;
    const { container } = renderChrome("full", true);
    const inline = container.querySelector("[inert]");
    expect(inline).toBeDefined();
    expect(within(inline as HTMLElement).getByText("directions")).toBeDefined();
    sentinelState.passed = false;
  });

  it("leaves the inline chips reachable while the docked copy is absent", () => {
    sentinelState.passed = false;
    const { container } = renderChrome("full", true);
    expect(container.querySelector("[inert]")).toBeNull();
  });
});

function renderPlace(p: Place) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileSheetContext.Provider
        value={{ detent: "mid", isExpanded: false, inSheet: true, snapTo: () => {} }}
      >
        <PlaceDetailContent place={p} isLoading={false} />
      </MobileSheetContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PlaceDetailContent brand header", () => {
  // Regression coverage: the header used to gate on `place.brand?.wikidata`
  // alone, which Overture populates but a pure-OSM place never carries — the
  // default for a self-hoster without Overture ingested, and the only path
  // for network:/operator: identities. It must use the same
  // brand:>network:>operator: precedence the pin and the list row use.
  it("shows a logo for a place whose only identity is operator:wikidata (no Overture place.brand)", () => {
    mockUseBrandDetail.mockReturnValue({ data: { logoFile: "Q-Park logo.svg" } });
    const osmPlace = {
      id: "p-op",
      name: "Q-Park Neumarkt",
      coordinates: [6.0839, 50.7753],
      osmTags: { "operator:wikidata": "Q1127798" },
    } as unknown as Place;

    renderPlace(osmPlace);

    expect(screen.getByAltText("Q-Park Neumarkt")).toBeInTheDocument();
  });

  it("shows a logo for a place whose only identity is network:wikidata (EV charging)", () => {
    mockUseBrandDetail.mockReturnValue({ data: { logoFile: "Ionity logo.svg" } });
    const osmPlace = {
      id: "p-net",
      name: "Ionity Charger",
      coordinates: [6.0839, 50.7753],
      osmTags: { "network:wikidata": "Q42717773" },
    } as unknown as Place;

    renderPlace(osmPlace);

    expect(screen.getByAltText("Ionity Charger")).toBeInTheDocument();
  });

  it("renders the plain title, unchanged, for a place with no brand identity at all", () => {
    renderPlace(place);
    expect(screen.getByText("Test Place")).toBeInTheDocument();
    expect(screen.queryByRole("img")).toBeNull();
  });
});
