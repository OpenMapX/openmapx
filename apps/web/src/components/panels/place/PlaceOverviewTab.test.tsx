import type { Place } from "@openmapx/core";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { createQueryWrapper } from "@/test/query";

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => "en",
}));

vi.mock("@openmapx/mangrove-react", () => ({
  useReviewAggregate: () => ({ data: undefined, isLoading: false }),
}));

vi.mock("./PlacePhotoGallery", () => ({ PlacePhotoGallery: () => null }));

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

  it("mounts an independent collapsed air-quality row beside Weather with normalized hints", () => {
    airQualityProps.mockClear();
    renderOverview(ENRICHED);

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

    const airQuality = screen.getByRole("button", { name: "section" });
    airQuality.focus();
    await user.keyboard("{Enter}");

    expect(airQuality).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByTestId("place-air-quality")).toBeVisible();
  });
});
