import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachTariffs, mapNlDotnlTariff, parseNlDotnlTariffs } from "../nl-dotnl-tariff.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "netherlands-tariffs-sample.json"));

// Every fixture tariff is single-element, so each maps to an array of exactly
// one EvChargingTariff; `first` pulls it out for the single-tariff assertions.
const parse = () => parseNlDotnlTariffs(FIXTURE);
const first = (id: string) => parse().get(id)?.[0];

describe("parseNlDotnlTariffs", () => {
  it("maps ENERGY/TIME/FLAT/PARKING_TIME price components and drops a stray unmapped type", () => {
    const efl = first("t-62b5709e191e25e2a4482cac-1");
    expect(efl).toBeDefined();
    expect(efl?.elements.map((e) => e.type)).toEqual(["flat", "time", "energy"]);
    expect(efl?.elements.every((e) => e.currency === "EUR")).toBe(true);

    const nuo = first("1700009669");
    expect(nuo).toBeDefined();
    // The stray "REGULAR" price_component must be dropped entirely, not
    // emitted with `type: undefined`.
    expect(nuo?.elements.map((e) => e.type)).toEqual(["energy", "parking"]);
    expect(nuo?.elements.every((e) => e.type !== undefined)).toBe(true);
  });

  it("maps restrictions min_power/max_power (kW) and the time-of-day window", () => {
    const nuo = first("1700009669");
    expect(nuo?.restrictions).toEqual({
      timeOfDayStart: "00:00",
      timeOfDayEnd: "07:00",
      minPowerKw: 11,
      maxPowerKw: 50,
    });
  });

  it("leaves restrictions undefined for a tariff with none", () => {
    expect(first("t-62b5709e191e25e2a4482cac-1")?.restrictions).toBeUndefined();
  });

  it("carries vat percentage and stepSize through per component", () => {
    const efl = first("t-62b5709e191e25e2a4482cac-1");
    const energy = efl?.elements.find((e) => e.type === "energy");
    const flat = efl?.elements.find((e) => e.type === "flat");
    expect(energy?.vat).toBe(21);
    expect(energy?.stepSize).toBe(1);
    expect(flat?.vat).toBeUndefined();
  });

  it("maps AD_HOC_PAYMENT tariff type to isDirectPayment true", () => {
    expect(first("677")?.isDirectPayment).toBe(true);
  });

  it("leaves isDirectPayment undefined for non-direct-payment tariffs", () => {
    expect(first("t-62b5709e191e25e2a4482cac-1")?.isDirectPayment).toBeUndefined();
  });

  it("maps tariff_alt_text to a single string, preferring the english entry", () => {
    expect(first("1700009669")?.altText).toBe("Night rate applies");
  });

  it("falls back to the dutch entry when no english tariff_alt_text is present", () => {
    expect(first("677")?.altText).toBe("Alleen direct betalen");
  });

  it("leaves altText undefined when tariff_alt_text is null", () => {
    expect(first("t-62b5709e191e25e2a4482cac-1")?.altText).toBeUndefined();
  });

  it("confirms sourceUrl maps from tariff_alt_url", () => {
    expect(first("1700009669")?.sourceUrl).toBe("https://example.org/tariffs/1700009669");
  });

  it("sets scope cpo and source nl-dotnl on every mapped tariff", () => {
    const map = parse();
    expect(map.size).toBe(3);
    for (const tariffs of map.values()) {
      for (const tariff of tariffs) {
        expect(tariff.scope).toBe("cpo");
        expect(tariff.source).toBe("nl-dotnl");
      }
    }
  });
});

describe("mapNlDotnlTariff split", () => {
  it("splits a base energy price and a duration-gated parking fee into separate tariffs", () => {
    const tariffs = mapNlDotnlTariff({
      id: "x",
      currency: "EUR",
      type: "REGULAR",
      elements: [
        { price_components: [{ type: "ENERGY", price: 0.375, vat: 21 }] },
        {
          price_components: [{ type: "PARKING_TIME", price: 0.05 }],
          restrictions: { max_duration: 300 },
        },
      ],
    });
    expect(tariffs).toHaveLength(2);
    const energy = tariffs.find((t) => t.elements[0].type === "energy");
    const parking = tariffs.find((t) => t.elements[0].type === "parking");
    // The energy price must NOT inherit the parking fee's duration condition.
    expect(energy?.restrictions).toBeUndefined();
    expect(parking?.restrictions).toMatchObject({ maxDurationMinutes: 5 });
    expect(tariffs.every((t) => t.source === "nl-dotnl" && t.scope === "cpo")).toBe(true);
  });
});

describe("attachTariffs", () => {
  const map = parse();

  it("attaches the matching tariffs from the map, deduped, in first-seen order", () => {
    const attached = attachTariffs(
      ["t-62b5709e191e25e2a4482cac-1", "t-62b5709e191e25e2a4482cac-1", "677"],
      map,
    );
    expect(attached).toHaveLength(2);
    expect(attached?.[0]).toBe(map.get("t-62b5709e191e25e2a4482cac-1")?.[0]);
    expect(attached?.[1]).toBe(map.get("677")?.[0]);
  });

  it("returns undefined when no tariff_ids are given", () => {
    expect(attachTariffs(undefined, map)).toBeUndefined();
    expect(attachTariffs([], map)).toBeUndefined();
  });

  it("skips ids with no matching tariff in the map rather than throwing", () => {
    expect(attachTariffs(["does-not-exist"], map)).toBeUndefined();
    expect(attachTariffs(["does-not-exist", "677"], map)).toEqual(map.get("677"));
  });
});
