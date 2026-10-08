import type { EvDirectionsResult } from "@openmapx/core";
import de from "@openmapx/i18n/locales/de.json";
import en from "@openmapx/i18n/locales/en.json";
import { describe, expect, it } from "vitest";
import { createQueryWrapper } from "@/test";
import { renderWithIntl } from "@/test/intl";
import { EvPlanCard } from "./EvPlanCard";

const NB = " ";

const result: EvDirectionsResult = {
  routes: [
    { distance: 300_000, duration: 12_000, geometry: [], legs: [], steps: [], mode: "driving" },
  ],
  activeRouteIndex: 0,
  waypoints: [
    [6.08, 50.78],
    [6.95, 50.94],
  ],
  stops: [
    {
      station: {
        id: "oc:feature:de-bnetza-charging:1",
        name: "Ionity Aachen",
        coordinates: [6, 50],
      },
      connector: "ccs2",
      powerKw: 150,
      operator: "Ionity",
      isPreferredNetwork: false,
      arriveSocPct: 12,
      departSocPct: 80,
      chargeSeconds: 1500,
      addedKwh: 40,
      tariffPrice: { amount: 0.389, currency: "EUR", unit: "kWh" },
      estimatedCost: { amount: 15.56, currency: "EUR" },
      attributions: [],
    },
  ],
  totals: { driveSeconds: 12_000, chargeSeconds: 1500, energyKwh: 55 },
  warnings: [],
};

async function cardIn(locale: "en" | "de", shown: EvDirectionsResult = result) {
  const Wrapper = createQueryWrapper();
  return renderWithIntl(
    <Wrapper>
      <EvPlanCard result={shown} />
    </Wrapper>,
    { locale, messages: locale === "de" ? de : en },
  );
}

/** The plan with its one stop priced per hour of charging. */
const hourly: EvDirectionsResult = {
  ...result,
  stops: result.stops.map((stop) => ({
    ...stop,
    tariffPrice: { amount: 6, currency: "EUR", unit: "h" as const },
    estimatedCost: undefined,
  })),
};

/** The leaf element whose raw text (no-break spaces kept) is exactly `text`. */
const exactly = (text: string) => (_: string, el: Element | null) =>
  el !== null && el.children.length === 0 && el.textContent === text;

describe("EvPlanCard prices", () => {
  it("writes the tariff price and the stop cost in the reader's locale", async () => {
    const english = await cardIn("en");
    english.getByText(exactly("€15.56 · €0.389/kWh"));
    english.unmount();

    const german = await cardIn("de");
    german.getByText(exactly(`15,56${NB}€ · 0,389${NB}€/kWh`));
    expect(german.queryByText(/EUR/)).toBeNull();
  });

  it("names an hourly price's unit as the charger's place card does", async () => {
    const english = await cardIn("en", hourly);
    english.getByText(exactly("€6.00/h"));
    english.unmount();

    const german = await cardIn("de", hourly);
    german.getByText(exactly(`6,00${NB}€/Std.`));
  });
});
