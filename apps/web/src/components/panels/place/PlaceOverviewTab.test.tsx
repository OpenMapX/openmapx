import { computePlusCode, type Place } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/query";
import { MobileSheetContext } from "../sheet/sheetState";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

// Keep signed-out place rendering independent of Better Auth's session fetch
// and delayed listener cleanup, which can outlive this file's jsdom environment.
// Mock at the shared hook so the real saved-place hooks use the same session.
vi.mock("../../../../../../packages/core/src/auth/useSession", () => ({
  useSession: () => ({
    data: null,
    error: null,
    isPending: false,
    isRefetching: false,
    refetch: vi.fn(),
  }),
}));

vi.mock("@openmapx/mangrove-react", () => ({
  useReviewAggregate: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("./PlacePhotoGallery", () => ({ PlacePhotoGallery: () => null }));
vi.mock("./PlaceHarborFacilities", () => ({ PlaceHarborFacilities: () => null }));
vi.mock("./PlaceLocalTime", () => ({
  PlaceLocalTime: () => <div data-testid="place-local-time" />,
}));

const airQualityProps = vi.fn();
vi.mock("./PlaceAirQuality", () => ({
  PlaceAirQuality: (props: Record<string, unknown>) => {
    airQualityProps(props);
    return <div data-testid="place-air-quality">air-quality-content</div>;
  },
}));

/** Captures exactly what the overview hands the contribution entry. */
const entryProps = vi.fn();
vi.mock("./contributions/OsmContributionEntry", () => ({
  OsmContributionEntry: (props: Record<string, unknown>) => {
    entryProps(props);
    return null;
  },
}));

class StubIntersectionObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("IntersectionObserver", StubIntersectionObserver);

const { PlaceOverviewTab } = await import("./PlaceOverviewTab");

/**
 * A place carrying exactly the kind of merged/enriched values that must never
 * reach an OpenStreetMap editor control.
 */
const ENRICHED = {
  id: "p1",
  name: "Enriched Display Name",
  coordinates: [13.4, 52.5],
  primaryScheme: "osm",
  ids: { osm: "node/12345", wikidata: "Q42" },
  address: "Enriched Street 9, 10115 Berlin",
  website: "https://enriched.example",
  phone: "+49 30 000000",
  openingHours: { status: "open" },
  osmTags: { amenity: "cafe", name: "Different OSM Name", "addr:street": "Hauptstraße" },
  category: "cafe",
  description: "An enriched description from a knowledge provider.",
  countryCode: "de",
  airport: { isoRegion: "DE-BE" },
} as unknown as Place;

function renderOverview(place: Place) {
  return render(
    <PlaceOverviewTab
      place={place}
      isLoading={false}
      onNavigateToInfo={() => {}}
      onOpenDepartures={() => {}}
      onOpenLineDetail={() => {}}
    />,
    { wrapper: createQueryWrapper() },
  );
}

describe("OSM contribution entry placement", () => {
  it("passes only the canonical OSM reference, never enriched place content", () => {
    entryProps.mockClear();
    renderOverview(ENRICHED);

    expect(entryProps).toHaveBeenCalled();
    const props = entryProps.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props).toEqual({ osmId: "node/12345" });

    const serialized = JSON.stringify(props);
    for (const enriched of [
      "Enriched Display Name",
      "Enriched Street 9",
      "https://enriched.example",
      "+49 30 000000",
      "Different OSM Name",
      "Hauptstraße",
      "Q42",
      "enriched description",
    ]) {
      expect(serialized).not.toContain(enriched);
    }
  });

  it("passes undefined when the place has no OSM reference", () => {
    entryProps.mockClear();
    renderOverview({ ...ENRICHED, ids: {} } as unknown as Place);
    const props = entryProps.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(props.osmId).toBeUndefined();
  });

  it("groups conditions for a business and keeps weather and air quality lazy and independent", () => {
    airQualityProps.mockClear();
    renderOverview(ENRICHED);

    const conditions = screen.getByRole("button", { name: "conditions" });
    expect(conditions).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "currentWeather" })).not.toBeInTheDocument();
    fireEvent.click(conditions);

    const weather = screen.getByRole("button", { name: "currentWeather" });
    const airQuality = screen.getByRole("button", { name: "section" });
    expect(weather).toHaveAttribute("aria-expanded", "false");
    expect(airQuality).toHaveAttribute("aria-expanded", "false");
    expect(airQualityProps).not.toHaveBeenCalled();

    fireEvent.click(weather);
    expect(weather).toHaveAttribute("aria-expanded", "true");
    expect(airQuality).toHaveAttribute("aria-expanded", "false");
    expect(airQualityProps).not.toHaveBeenCalled();

    fireEvent.click(airQuality);
    expect(airQuality).toHaveAttribute("aria-expanded", "true");
    expect(weather).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("place-air-quality")).toBeVisible();
    expect(airQualityProps).toHaveBeenLastCalledWith({
      lat: 52.5,
      lng: 13.4,
      enabled: true,
      countryCode: "DE",
      subdivisionCode: "DE-BE",
    });
  });

  it("expands the air-quality disclosure from the keyboard", async () => {
    const user = userEvent.setup();
    airQualityProps.mockClear();
    renderOverview(ENRICHED);

    await user.click(screen.getByRole("button", { name: "conditions" }));
    const airQuality = screen.getByRole("button", { name: "section" });
    airQuality.focus();
    await user.keyboard("{Enter}");

    expect(airQuality).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("place-air-quality")).toBeVisible();
  });
});

describe("uncertain opening hours", () => {
  it("shows a field-specific source and check date only inside expanded hours", async () => {
    const user = userEvent.setup();
    renderOverview({
      ...ENRICHED,
      openingHours: "Mo-Fr 09:00-17:00",
      openingHoursInfo: { status: { isOpen: false, isUnknown: true, text: "Mo-Fr 09:00-17:00" } },
      openingHoursSource: { name: "survey", checkedAt: "2026-09-01", url: "javascript:alert(1)" },
    } as unknown as Place);
    expect(screen.queryByText("survey")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "unconfirmed" }));
    expect(screen.getByText(/survey/)).toBeVisible();
    expect(screen.queryByRole("link", { name: "survey" })).not.toBeInTheDocument();
    expect(screen.getByText(/checkedOn/)).toBeVisible();
  });

  it("shows an HTTP source link without manufacturing a check date", async () => {
    const user = userEvent.setup();
    renderOverview({
      ...ENRICHED,
      openingHours: "Mo-Fr 09:00-17:00",
      openingHoursInfo: { status: { isOpen: false, isUnknown: true, text: "Mo-Fr 09:00-17:00" } },
      openingHoursSource: { name: "OpenStreetMap", url: "https://www.openstreetmap.org/node/1" },
    } as unknown as Place);
    await user.click(screen.getByRole("button", { name: "unconfirmed" }));
    expect(screen.getByRole("link", { name: "OpenStreetMap" })).toHaveAttribute(
      "href",
      "https://www.openstreetmap.org/node/1",
    );
    expect(screen.queryByText(/checkedOn/)).not.toBeInTheDocument();
  });
  it("shows a neutral disclosure and keeps the reported value and comment reachable", async () => {
    const user = userEvent.setup();
    renderOverview({
      ...ENRICHED,
      openingHours: 'Mo-Fr 09:00-17:00 "by appointment"',
      openingHoursInfo: {
        status: {
          isOpen: false,
          isUnknown: true,
          text: "by appointment",
          comment: "by appointment",
        },
      },
    } as unknown as Place);

    const disclosure = screen.getByRole("button", { name: "unconfirmed" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByText('Mo-Fr 09:00-17:00 "by appointment"')).not.toBeInTheDocument();
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText('Mo-Fr 09:00-17:00 "by appointment"')).toBeVisible();
  });

  it("does not suggest an hours verdict when no hours were reported", () => {
    renderOverview({
      ...ENRICHED,
      openingHours: undefined,
      openingHoursInfo: undefined,
    } as unknown as Place);

    expect(screen.queryByText("unconfirmed")).not.toBeInTheDocument();
    expect(screen.queryByText("reportedHours")).not.toBeInTheDocument();
  });
});

function isBefore(first: Element, second: Element) {
  return Boolean(first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING);
}

describe("visit order", () => {
  it("puts food amenities ahead of weather, with technical tags later and no duplicate facts", () => {
    const { container } = renderOverview({
      ...ENRICHED,
      openingHoursInfo: { status: { isOpen: true } },
      osmTags: {
        amenity: "cafe",
        cuisine: "mexican",
        takeaway: "yes",
        internet_access: "wlan",
        operator: "Operator Co",
        capacity: "40",
      },
    } as unknown as Place);

    const address = screen.getByText("Enriched Street 9, 10115 Berlin");
    const cuisine = screen.getByText("Mexican");
    const takeaway = screen.getByText("takeawayYes");
    const wifi = screen.getByText("wifiAvailable");
    const weather = screen.getByRole("button", { name: "conditions" });
    const operator = screen.getByText("Operator Co");
    const plusCode = container.querySelector('a[href^="https://plus.codes/"]');
    expect(plusCode).not.toBeNull();

    expect(isBefore(address, cuisine)).toBe(true);
    expect(isBefore(cuisine, weather)).toBe(true);
    expect(isBefore(takeaway, weather)).toBe(true);
    expect(isBefore(wifi, weather)).toBe(true);
    expect(isBefore(weather, operator)).toBe(true);
    expect(isBefore(weather, plusCode as Element)).toBe(true);
    // Local time is a location fact beside the Plus Code, not a condition:
    // it shows with the group still collapsed.
    const localTime = screen.getByTestId("place-local-time");
    expect(weather).toHaveAttribute("aria-expanded", "false");
    expect(isBefore(weather, localTime)).toBe(true);
    expect(localTime.nextElementSibling?.contains(plusCode)).toBe(true);
    expect(screen.getAllByText("Mexican")).toHaveLength(1);
    expect(screen.getAllByText("takeawayYes")).toHaveLength(1);
  });

  it("keeps weather ahead of amenities for a city and an explicit outdoor destination", () => {
    for (const tags of [
      { place: "city", internet_access: "wlan" },
      { natural: "beach", internet_access: "wlan" },
    ]) {
      const view = renderOverview({ ...ENRICHED, osmTags: tags } as unknown as Place);
      expect(
        isBefore(
          screen.getByRole("button", { name: "currentWeather" }),
          screen.getByText("wifiAvailable"),
        ),
      ).toBe(true);
      view.unmount();
    }
  });

  it("keeps marine conditions prominent for a harbor", () => {
    renderOverview({ ...ENRICHED, primaryScheme: "openseamap-harbour" } as unknown as Place);
    expect(screen.getByRole("button", { name: "currentWeather" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "conditions" })).not.toBeInTheDocument();
  });

  it("places OSM-only business email before weather without duplicating a contact already in Overview", () => {
    const { rerender } = renderOverview({
      ...ENRICHED,
      email: undefined,
      osmTags: { amenity: "bar", email: "info@example.org" },
    } as unknown as Place);
    const email = screen.getByRole("link", { name: "info@example.org" });
    expect(isBefore(email, screen.getByRole("button", { name: "conditions" }))).toBe(true);

    rerender(
      <PlaceOverviewTab
        place={
          {
            ...ENRICHED,
            email: "info@example.org",
            osmTags: { amenity: "bar", email: "info@example.org" },
          } as unknown as Place
        }
        isLoading={false}
        onNavigateToInfo={() => {}}
        onOpenDepartures={() => {}}
        onOpenLineDetail={() => {}}
      />,
    );
    expect(screen.getAllByRole("link", { name: "info@example.org" })).toHaveLength(1);
  });

  it("does not render an empty prominent address row for a sparse place", () => {
    const { container } = renderOverview({
      ...ENRICHED,
      address: "  ",
      phone: undefined,
      website: undefined,
      email: undefined,
      osmTags: undefined,
    } as unknown as Place);
    expect(container.querySelector('a[href^="https://plus.codes/"]')).toBeVisible();
    expect(
      [...container.querySelectorAll("p")].filter((paragraph) => !paragraph.textContent?.trim()),
    ).toHaveLength(0);
  });

  it("shows two labeled landmark facts and a single visible Plus Code", () => {
    const { container } = renderOverview({
      ...ENRICHED,
      city: "Berlin",
      facts: [
        { label: "Opened", value: "1969" },
        { label: "Height", value: "368 m" },
        { label: "Architect", value: "Fritz Leonhardt" },
      ],
    } as unknown as Place);

    expect(screen.getByText("Opened")).toBeVisible();
    expect(screen.getByText("1969")).toBeVisible();
    expect(screen.getByText("Height")).toBeVisible();
    expect(screen.queryByText("Architect")).not.toBeInTheDocument();

    const plusCode = computePlusCode(ENRICHED.coordinates);
    const link = container.querySelector('a[href^="https://plus.codes/"]');
    expect(link).toBeVisible();
    expect(link).toHaveTextContent("Berlin");
    expect(screen.queryByText(plusCode)).not.toBeInTheDocument();
  });

  it("places the mobile description after visit details and before conditions", () => {
    render(
      <MobileSheetContext.Provider
        value={{ inSheet: true, detent: "full", isExpanded: true, snapTo: () => {} }}
      >
        <PlaceOverviewTab
          place={ENRICHED}
          isLoading={false}
          onNavigateToInfo={() => {}}
          onOpenDepartures={() => {}}
          onOpenLineDetail={() => {}}
        />
      </MobileSheetContext.Provider>,
      { wrapper: createQueryWrapper() },
    );

    const address = screen.getByText("Enriched Street 9, 10115 Berlin");
    const description = screen.getByText("An enriched description from a knowledge provider.");
    const conditions = screen.getByRole("button", { name: "conditions" });
    expect(isBefore(address, description)).toBe(true);
    expect(isBefore(description, conditions)).toBe(true);
  });
});

describe("detail copy actions", () => {
  it("copies the address from the keyboard and announces success", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderOverview(ENRICHED);

    const copyAddress = screen.getByRole("button", { name: "copyAddress" });
    copyAddress.focus();
    await user.keyboard("{Enter}");

    expect(writeText).toHaveBeenCalledWith("Enriched Street 9, 10115 Berlin");
    expect(screen.getByRole("button", { name: "copied" })).toBe(copyAddress);
  });

  it("copies the canonical Plus Code while displaying only the short city form", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    renderOverview({ ...ENRICHED, city: "Berlin" } as unknown as Place);

    await user.click(screen.getByRole("button", { name: "copyPlusCode" }));
    expect(writeText).toHaveBeenCalledWith(computePlusCode(ENRICHED.coordinates));
  });
});
