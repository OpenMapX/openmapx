import type { Place } from "@openmapx/core";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
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

function renderAtDetent(detent: "peek" | "mid" | "full") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MobileSheetContext.Provider
        value={{ detent, isExpanded: detent === "full", inSheet: true, snapTo: () => {} }}
      >
        <PlaceDetailContent place={place} isLoading={false} />
      </MobileSheetContext.Provider>
    </QueryClientProvider>,
  );
}

describe("PlaceDetailContent per detent", () => {
  it("keeps the title at peek", () => {
    renderAtDetent("peek");
    expect(screen.getByText("Test Place")).toBeDefined();
  });

  it("drops the secondary meta rows at peek", () => {
    renderAtDetent("peek");
    expect(screen.queryByTestId("place-meta-rows")).toBeNull();
  });

  it("restores them at mid", () => {
    renderAtDetent("mid");
    expect(screen.getByTestId("place-meta-rows")).toBeDefined();
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
