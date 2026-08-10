import { describe, expect, it } from "vitest";
import { loadEditorIndex } from "../editor-loader";

const index = loadEditorIndex();

describe("editor index", () => {
  it("is cached and returns the same immutable instance", () => {
    expect(loadEditorIndex()).toBe(index);
    expect(Object.isFrozen(index)).toBe(true);
  });

  it("retains a concrete preset with its identifying tags, geometry and field ids", () => {
    const restaurant = index.presets.get("amenity/restaurant");
    expect(restaurant).toBeDefined();
    if (!restaurant) return;
    expect(restaurant.tags).toEqual({ amenity: "restaurant" });
    expect(restaurant.concreteTags).toEqual({ amenity: "restaurant" });
    expect(restaurant.hasWildcardTags).toBe(false);
    expect([...restaurant.geometry].sort()).toEqual(["area", "point"]);
    expect(restaurant.searchable).toBe(true);
    expect(restaurant.icon).toBe("maki-restaurant");
    expect(restaurant.matchScore).toBe(1);
    for (const fieldId of ["name", "address", "opening_hours", "phone", "website"]) {
      expect(restaurant.fieldIds).toContain(fieldId);
    }
    // `moreFields` are retained too, so `wheelchair`/`email` stay discoverable.
    expect(restaurant.fieldIds).toContain("wheelchair");
    expect(restaurant.fieldIds).toContain("email");
  });

  it("marks a wildcard-only preset so it can never make a category editable", () => {
    const shop = index.presets.get("shop");
    expect(shop).toBeDefined();
    if (!shop) return;
    expect(shop.tags).toEqual({ shop: "*" });
    expect(shop.hasWildcardTags).toBe(true);
    expect(shop.concreteTags).toEqual({});
  });

  it("retains unsearchable presets but flags them", () => {
    const template = index.presets.get("@templates/contact");
    expect(template).toBeDefined();
    expect(template?.searchable).toBe(false);
  });

  it("normalizes vertex geometry to point and keeps relation geometry", () => {
    const parking = index.presets.get("amenity/parking");
    expect(parking?.geometry).toContain("point");
    expect(parking?.geometry).not.toContain("vertex" as never);
    const stopArea = index.presets.get("public_transport/stop_area");
    expect(stopArea?.geometry).toEqual(["relation"]);
  });

  it("marks schema deprecations without applying them", () => {
    expect(index.presets.get("shop/boutique")?.deprecated).toBe(true);
    expect(index.presets.get("amenity/restaurant")?.deprecated).toBe(false);
    // The replacement is available for audit but never auto-applied.
    expect(index.presets.get("shop/boutique")?.tags).toEqual({ shop: "boutique" });
  });

  it("marks lifecycle-prefixed presets", () => {
    expect(index.presets.get("disused/shop")?.lifecycle).toBe(true);
    expect(index.presets.get("amenity/restaurant")?.lifecycle).toBe(false);
  });

  it("indexes localized names and terms for the enabled languages only", () => {
    expect(index.text.get("en")?.get("amenity/cafe")?.name).toBe("Cafe");
    expect(index.text.get("de")?.get("amenity/cafe")?.name).toBe("Café");
    expect(index.text.get("de")?.get("shop/bakery")?.name).toBe("Bäckerei");
    expect([...index.text.keys()].sort()).toEqual(["de", "en"]);
    expect(index.text.get("de")?.get("amenity/restaurant")?.normalizedTerms).toContain("pizzeria");
  });

  it("retains only the v1 field metadata, including alias keys and choices", () => {
    expect(index.fields.get("phone")?.keys).toEqual(["phone", "contact:phone"]);
    expect(index.fields.get("email")?.keys).toEqual(["email", "contact:email"]);
    expect(index.fields.get("website")?.keys).toEqual(["website", "contact:website"]);
    expect(index.fields.get("name")?.keys).toEqual(["name"]);
    expect(index.fields.get("opening_hours")?.keys).toEqual(["opening_hours"]);
    expect(index.fields.get("wheelchair")?.options).toEqual(["designated", "yes", "limited", "no"]);
    expect(index.fields.get("address")?.keys).toContain("addr:housenumber");
    // Fields outside the v1 allowlist are not indexed at all.
    expect(index.fields.get("cuisine")).toBeUndefined();
    expect(index.fields.get("operator")).toBeUndefined();
  });

  it("provides localized field and address-component labels", () => {
    expect(index.fieldLabels.get("en")?.get("wheelchair")).toBe("Wheelchair Access");
    expect(index.fieldLabels.get("de")?.get("wheelchair")).toBe("Rollstuhlzugang");
    expect(index.fieldLabels.get("de")?.get("opening_hours")).toBe("Öffnungszeiten");
    expect(index.addressLabels.get("de")?.get("housenumber")).toBe("Hausnummer");
    expect(index.addressLabels.get("en")?.get("street")).toBe("Street");
    expect(index.optionLabels.get("de")?.get("wheelchair:designated")).toBe("Ausgewiesen");
  });

  it("freezes every entry so callers cannot mutate the shared cache", () => {
    const restaurant = index.presets.get("amenity/restaurant");
    expect(Object.isFrozen(restaurant)).toBe(true);
    expect(Object.isFrozen(restaurant?.tags)).toBe(true);
    expect(() => {
      (restaurant as unknown as { presetId: string }).presetId = "hacked";
    }).toThrow();
  });
});

describe("browser exposure", () => {
  it("keeps raw tagging-schema JSON out of the client-reachable core barrel", async () => {
    const core = (await import("@openmapx/core")) as Record<string, unknown>;
    for (const key of Object.keys(core)) {
      expect(key).not.toMatch(/presets\.min|fields\.min|deprecated\.min|rawSchema/i);
    }
    // The editor index is server/build-side only: it is not exported from core.
    expect(core.loadEditorIndex).toBeUndefined();
    expect(core.buildEditableFieldModel).toBeUndefined();
  });
});
