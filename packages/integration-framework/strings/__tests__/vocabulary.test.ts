import { describe, expect, it } from "vitest";
import {
  type I18nToken,
  resolveToken,
  sharedStrings,
  vocabularyLabel,
  vocabularyLabels,
} from "../index.js";
import de from "../locales/de.json" with { type: "json" };
import en from "../locales/en.json" with { type: "json" };

/** OpenConditions' `PAYMENT_METHODS`. */
const PAYMENT_METHODS = [
  "cash",
  "credit_card",
  "debit_card",
  "card",
  "contactless",
  "app",
  "rfid",
  "sms",
  "membership",
  "direct_debit",
  "prepaid_card",
  "free",
  "other",
];

/** OpenConditions' `AUTHENTICATION_METHODS`. */
const AUTHENTICATION_METHODS = [
  "none",
  "rfid",
  "app",
  "plug_and_charge",
  "credit_card",
  "debit_card",
  "nfc",
  "qr",
  "remote",
  "pin",
];

/** OpenConditions' kernel `AMENITIES` and the fuel module's `FUEL_STATION_AMENITIES`. */
const AMENITIES = [
  "hotel",
  "motel",
  "overnight_accommodation",
  "shop",
  "kiosk",
  "food_shopping",
  "supermarket",
  "mall",
  "cafe",
  "restaurant",
  "self_service_restaurant",
  "motorway_restaurant",
  "spare_parts_shop",
  "petrol_station",
  "charging_station",
  "vehicle_maintenance",
  "tyre_repair",
  "truck_repair",
  "truck_wash",
  "car_wash",
  "car_rental",
  "pharmacy",
  "medical_facility",
  "first_aid",
  "defibrillator",
  "police",
  "tourist_information",
  "information_point",
  "bike_sharing",
  "bike_parking",
  "docstop",
  "laundry",
  "leisure",
  "sport",
  "recreation_area",
  "nature",
  "museum",
  "playground",
  "picnic_facilities",
  "toilets",
  "shower",
  "wifi",
  "internet_terminal",
  "public_phone",
  "cash_machine",
  "payment_machine",
  "vending_machine",
  "safe_deposit",
  "luggage_locker",
  "elevator",
  "fresh_water",
  "power_outlet",
  "waste_disposal",
  "refuse_bin",
  "dumping_station",
  "fire_extinguisher",
  "fire_hydrant",
  "toll_terminal",
  "bus_stop",
  "tram_stop",
  "taxi_stand",
  "metro_station",
  "train_station",
  "public_transport_hub",
  "airport",
  "parking",
  "carpool_parking",
  "compressed_air",
  "parcel_pickup",
  "baby_changing",
  "bar",
  "takeaway",
  "bottled_gas",
  "heating_oil",
  "lamp_oil",
  "fuel_additives",
];

const VOCABULARIES = {
  payment: PAYMENT_METHODS,
  authentication: AUTHENTICATION_METHODS,
  amenity: AMENITIES,
} as const;

function text(label: I18nToken | string, locale: string): string {
  if (typeof label === "string") return label;
  return resolveToken(label, {
    locale,
    fallbackLocale: "en",
    shared: sharedStrings,
    integration: undefined,
  });
}

describe("vocabularyLabel", () => {
  it("labels every OpenConditions value in every locale, and only those", () => {
    for (const [vocabulary, codes] of Object.entries(VOCABULARIES)) {
      const name = vocabulary as keyof typeof VOCABULARIES;
      for (const catalog of [en, de]) {
        expect(Object.keys(catalog.shared[name]).sort(), name).toEqual([...codes].sort());
      }
      for (const code of codes) {
        const label = vocabularyLabel(name, code);
        expect(label, `${name} ${code}`).toEqual({ $t: `shared.${name}.${code}` });
        for (const locale of ["en", "de"]) {
          expect(text(label, locale), `${name} ${code} ${locale}`).not.toContain("shared.");
        }
      }
    }
  });

  it("translates rather than copies the English labels", () => {
    expect(text(vocabularyLabel("payment", "cash"), "de")).toBe("Bargeld");
    expect(text(vocabularyLabel("authentication", "none"), "de")).toBe("Nicht erforderlich");
    expect(text(vocabularyLabel("amenity", "compressed_air"), "en")).toBe("Air pump");
    expect(text(vocabularyLabel("amenity", "compressed_air"), "de")).toBe("Luftdruckstation");
  });

  it("shows a value no catalog names in words, never as a key", () => {
    expect(vocabularyLabel("amenity", "ev_valet_service")).toBe("Ev valet service");
    expect(vocabularyLabel("payment", "toString")).toBe("ToString");
  });
});

describe("vocabularyLabels", () => {
  it("labels each distinct value once, in order, skipping blanks", () => {
    expect(vocabularyLabels("payment", ["app", "cash", "app", " ", "barter"])).toEqual([
      { $t: "shared.payment.app" },
      { $t: "shared.payment.cash" },
      "Barter",
    ]);
  });
});
