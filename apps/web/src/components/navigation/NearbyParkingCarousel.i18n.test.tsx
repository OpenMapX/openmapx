import de from "@openmapx/i18n/locales/de.json";
import en from "@openmapx/i18n/locales/en.json";
import { describe, expect, it, vi } from "vitest";
import { renderWithIntl } from "@/test/intl";
import { NearbyParkingCarousel } from "./NearbyParkingCarousel";
import type { NearbyParkingPlace } from "./nearbyParking";

vi.mock("@/components/panels/place/useDataSourceI18nResolver", () => ({
  useDataSourceI18nResolver: () => () => "",
}));

const garage: NearbyParkingPlace = {
  id: "p1",
  name: "Schillerplatz",
  coordinates: [9.178, 48.777],
  access: "customers",
  walk: { seconds: 250, meters: 320, contributors: [] },
};

function show(locale: "en" | "de", place: NearbyParkingPlace = garage) {
  return renderWithIntl(
    <NearbyParkingCarousel
      places={[place]}
      selectedPlace={null}
      isLoading={false}
      onSelectPlace={vi.fn()}
      onDriveToPlace={vi.fn()}
    />,
    { locale, messages: locale === "en" ? en : de },
  );
}

describe("NearbyParkingCarousel wording", () => {
  it("says how long the walk to the destination takes, in whole minutes", async () => {
    const { getByText } = await show("en");
    expect(getByText("4 min walk · 320 m")).toBeInTheDocument();
    expect(getByText("Customers only")).toBeInTheDocument();
  });

  it("says so in German, and never less than a minute", async () => {
    const { getByText } = await show("de", {
      ...garage,
      walk: { seconds: 20, meters: 25, contributors: [] },
    });
    expect(getByText("1 Min. zu Fuß · 25 m")).toBeInTheDocument();
    expect(getByText("Nur für Kunden")).toBeInTheDocument();
  });
});
