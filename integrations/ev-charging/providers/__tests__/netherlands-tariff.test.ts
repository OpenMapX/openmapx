import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { attachTariffs, parseDotNlTariffs } from "../netherlands-tariff.js";

const FIXTURE = readFileSync(join(__dirname, "fixtures", "netherlands-tariffs-sample.json"));

describe("parseDotNlTariffs", () => {
  it("maps ENERGY/TIME/FLAT/PARKING_TIME price components and drops a stray unmapped type", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const efl = map.get("t-62b5709e191e25e2a4482cac-1");
    expect(efl).toBeDefined();
    expect(efl?.elements.map((e) => e.type)).toEqual(["flat", "time", "energy"]);
    expect(efl?.elements.every((e) => e.currency === "EUR")).toBe(true);

    const nuo = map.get("1700009669");
    expect(nuo).toBeDefined();
    // The stray "REGULAR" price_component must be dropped entirely, not
    // emitted with `type: undefined`.
    expect(nuo?.elements.map((e) => e.type)).toEqual(["energy", "parking"]);
    expect(nuo?.elements.every((e) => e.type !== undefined)).toBe(true);
  });

  it("maps restrictions min_power/max_power (kW) and the time-of-day window", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const nuo = map.get("1700009669");
    expect(nuo?.restrictions).toEqual({
      timeOfDayStart: "00:00",
      timeOfDayEnd: "07:00",
      minPowerKw: 11,
      maxPowerKw: 50,
    });
  });

  it("leaves restrictions undefined for a tariff with none", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const efl = map.get("t-62b5709e191e25e2a4482cac-1");
    expect(efl?.restrictions).toBeUndefined();
  });

  it("carries vat percentage and stepSize through per component", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const efl = map.get("t-62b5709e191e25e2a4482cac-1");
    const energy = efl?.elements.find((e) => e.type === "energy");
    const flat = efl?.elements.find((e) => e.type === "flat");
    expect(energy?.vat).toBe(21);
    expect(energy?.stepSize).toBe(1);
    expect(flat?.vat).toBeUndefined();
  });

  it("maps AD_HOC_PAYMENT tariff type to isDirectPayment true", () => {
    const map = parseDotNlTariffs(FIXTURE);
    expect(map.get("677")?.isDirectPayment).toBe(true);
  });

  it("leaves isDirectPayment undefined for non-direct-payment tariffs", () => {
    const map = parseDotNlTariffs(FIXTURE);
    expect(map.get("t-62b5709e191e25e2a4482cac-1")?.isDirectPayment).toBeUndefined();
  });

  it("maps tariff_alt_text to a single string, preferring the english entry", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const nuo = map.get("1700009669");
    expect(nuo?.altText).toBe("Night rate applies");
  });

  it("falls back to the dutch entry when no english tariff_alt_text is present", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const adHoc = map.get("677");
    expect(adHoc?.altText).toBe("Alleen direct betalen");
  });

  it("leaves altText undefined when tariff_alt_text is null", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const efl = map.get("t-62b5709e191e25e2a4482cac-1");
    expect(efl?.altText).toBeUndefined();
  });

  it("confirms sourceUrl maps from tariff_alt_url", () => {
    const map = parseDotNlTariffs(FIXTURE);
    const nuo = map.get("1700009669");
    expect(nuo?.sourceUrl).toBe("https://example.org/tariffs/1700009669");
  });

  it("sets scope cpo and source netherlands-ev on every mapped tariff", () => {
    const map = parseDotNlTariffs(FIXTURE);
    expect(map.size).toBe(3);
    for (const tariff of map.values()) {
      expect(tariff.scope).toBe("cpo");
      expect(tariff.source).toBe("netherlands-ev");
    }
  });
});

describe("attachTariffs", () => {
  const map = parseDotNlTariffs(FIXTURE);

  it("attaches the matching tariffs from the map, deduped, in first-seen order", () => {
    const attached = attachTariffs(
      ["t-62b5709e191e25e2a4482cac-1", "t-62b5709e191e25e2a4482cac-1", "677"],
      map,
    );
    expect(attached).toHaveLength(2);
    expect(attached?.[0]).toBe(map.get("t-62b5709e191e25e2a4482cac-1"));
    expect(attached?.[1]).toBe(map.get("677"));
  });

  it("returns undefined when no tariff_ids are given", () => {
    expect(attachTariffs(undefined, map)).toBeUndefined();
    expect(attachTariffs([], map)).toBeUndefined();
  });

  it("skips ids with no matching tariff in the map rather than throwing", () => {
    expect(attachTariffs(["does-not-exist"], map)).toBeUndefined();
    expect(attachTariffs(["does-not-exist", "677"], map)).toEqual([map.get("677")]);
  });
});
