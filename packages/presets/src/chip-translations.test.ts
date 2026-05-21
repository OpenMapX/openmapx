import { describe, expect, it } from "vitest";
import { buildChipTranslations } from "./chip-translations";
import { loadPresetIndex } from "./loader";

const index = loadPresetIndex(["en", "de"]);

describe("buildChipTranslations", () => {
  it("returns the German display name for the fuel chip", () => {
    const slice = index.get("de");
    expect(slice).toBeDefined();
    if (!slice) return;
    const t = buildChipTranslations(slice);
    expect(t.fuel?.name).toBe("Tankstelle");
  });

  it("includes localized terms (e.g. 'tanke') for the fuel chip", () => {
    const slice = index.get("de");
    if (!slice) throw new Error("missing de slice");
    const t = buildChipTranslations(slice);
    expect(t.fuel?.terms).toContain("tanke");
  });

  it("returns a non-empty English display name for the pharmacies chip", () => {
    const slice = index.get("en");
    if (!slice) throw new Error("missing en slice");
    const t = buildChipTranslations(slice);
    expect(t.pharmacies?.name).toBeTruthy();
  });

  it("returns the German display name 'Apotheke' for pharmacies", () => {
    const slice = index.get("de");
    if (!slice) throw new Error("missing de slice");
    const t = buildChipTranslations(slice);
    expect(t.pharmacies?.name).toBe("Apotheke");
  });

  it("returns the German display name 'Geldautomat' for atms with localised aliases", () => {
    const slice = index.get("de");
    if (!slice) throw new Error("missing de slice");
    const t = buildChipTranslations(slice);
    expect(t.atms?.name).toBe("Geldautomat");
    expect(t.atms?.terms).toContain("bankomat");
  });

  it("omits multi-value chips (e.g. restaurants covers 5 amenity values)", () => {
    const slice = index.get("en");
    if (!slice) throw new Error("missing en slice");
    const t = buildChipTranslations(slice);
    expect(t.restaurants).toBeUndefined();
  });

  it("normalises terms (lowercase + no diacritics) so client matching is straight equality", () => {
    const slice = index.get("de");
    if (!slice) throw new Error("missing de slice");
    const t = buildChipTranslations(slice);
    for (const entry of Object.values(t)) {
      for (const term of entry.terms) {
        expect(term).toBe(term.toLowerCase());
        expect(term).not.toMatch(/[\u0300-\u036f]/);
      }
    }
  });
});
