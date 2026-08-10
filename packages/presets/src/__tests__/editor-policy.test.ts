import { describe, expect, it } from "vitest";
import {
  buildEditableFieldModel,
  getEditablePreset,
  inferEditableWayGeometry,
  matchEditablePreset,
  previewCategoryTransition,
  suggestEditablePresets,
} from "../editor-policy";
import type { EditableFieldDescriptor } from "../editor-types";
import { suggestPresets } from "../index";

function field(
  tags: Record<string, string>,
  name: string,
  geometry: "point" | "line" | "area" | "relation" = "point",
  lang?: string,
): EditableFieldDescriptor | undefined {
  return buildEditableFieldModel({ tags, geometry, lang }).fields.find((f) => f.field === name);
}

describe("matchEditablePreset", () => {
  it("matches a unique concrete preset", () => {
    const result = matchEditablePreset({ amenity: "restaurant" }, "point");
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.preset.presetId).toBe("amenity/restaurant");
    expect(result.preset.name).toBe("Restaurant");
  });

  it("prefers the more specific preset over its parent", () => {
    const result = matchEditablePreset({ amenity: "restaurant", building: "yes" }, "point");
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.preset.presetId).toBe("amenity/restaurant");
  });

  it("accepts the unified post-box preset from schema 7.1", () => {
    const result = matchEditablePreset({ amenity: "post_box" }, "point");
    expect(result.status).toBe("matched");
    if (result.status !== "matched") return;
    expect(result.preset.presetId).toBe("amenity/post_box");
  });

  it("reports ambiguity instead of picking the first tied regional candidate", () => {
    const result = matchEditablePreset({ traffic_sign: "maxspeed" }, "point");
    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") return;
    expect(result.candidates.map((c) => c.presetId).sort()).toEqual([
      "traffic_sign/maxspeed",
      "traffic_sign/maxspeed-US-CA-LR",
    ]);
  });

  it("refuses a wildcard-only match", () => {
    const result = matchEditablePreset({ shop: "openmapx_unknown_value" }, "point");
    expect(result).toEqual({ status: "unsupported", reason: "WILDCARD_ONLY" });
  });

  it("refuses a deprecated preset", () => {
    expect(matchEditablePreset({ shop: "boutique" }, "point")).toEqual({
      status: "unsupported",
      reason: "DEPRECATED",
    });
  });

  it("refuses a lifecycle-prefixed element", () => {
    expect(matchEditablePreset({ "disused:shop": "bakery" }, "point")).toEqual({
      status: "unsupported",
      reason: "LIFECYCLE",
    });
  });

  it("refuses a geometry mismatch rather than falling back to a weaker preset", () => {
    expect(matchEditablePreset({ amenity: "restaurant" }, "line")).toEqual({
      status: "unsupported",
      reason: "GEOMETRY",
    });
  });

  it("reports no match for tags the schema does not describe", () => {
    expect(matchEditablePreset({ openmapx_test: "value" }, "point")).toEqual({
      status: "unsupported",
      reason: "NO_MATCH",
    });
    expect(matchEditablePreset({}, "point")).toEqual({
      status: "unsupported",
      reason: "NO_MATCH",
    });
  });
});

describe("suggestEditablePresets", () => {
  it("returns concrete, searchable, geometry-compatible presets", () => {
    const results = suggestEditablePresets({ query: "restaurant", geometry: "point" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.map((r) => r.presetId)).toContain("amenity/restaurant");
    for (const result of results) {
      expect(result.geometry).toContain("point");
    }
    // Wildcard-only and deprecated presets can never be a target.
    expect(results.map((r) => r.presetId)).not.toContain("shop");
    expect(
      suggestEditablePresets({ query: "boutique", geometry: "point" }).map((r) => r.presetId),
    ).not.toContain("shop/boutique");
  });

  it("searches localized names", () => {
    const de = suggestEditablePresets({ query: "Bäckerei", geometry: "point", lang: "de" });
    expect(de.map((r) => r.presetId)).toContain("shop/bakery");
    expect(de.find((r) => r.presetId === "shop/bakery")?.name).toBe("Bäckerei");
    const en = suggestEditablePresets({ query: "Bäckerei", geometry: "point", lang: "en" });
    expect(en.map((r) => r.presetId)).not.toContain("shop/bakery");
  });

  it("returns nothing for an empty or overlong query", () => {
    expect(suggestEditablePresets({ query: "", geometry: "point" })).toEqual([]);
    expect(suggestEditablePresets({ query: "   ", geometry: "point" })).toEqual([]);
    expect(suggestEditablePresets({ query: "a".repeat(101), geometry: "point" })).toEqual([]);
  });

  it("clamps the limit to 1-20", () => {
    expect(
      suggestEditablePresets({ query: "s", geometry: "point", limit: 500 }).length,
    ).toBeLessThanOrEqual(20);
    expect(suggestEditablePresets({ query: "s", geometry: "point", limit: 0 }).length).toBe(1);
    expect(suggestEditablePresets({ query: "s", geometry: "point", limit: -5 }).length).toBe(1);
  });

  it("is deterministic across calls", () => {
    const a = suggestEditablePresets({ query: "cafe", geometry: "point" });
    const b = suggestEditablePresets({ query: "cafe", geometry: "point" });
    expect(a).toEqual(b);
  });

  it("leaves ordinary preset search untouched", () => {
    const search = suggestPresets("restaurant", "en", 5);
    expect(search.length).toBeGreaterThan(0);
    expect(search[0]?.id).toBe("amenity/restaurant");
  });
});

describe("getEditablePreset", () => {
  it("returns a summary for a compatible geometry only", () => {
    expect(getEditablePreset("amenity/restaurant", "point")?.name).toBe("Restaurant");
    expect(getEditablePreset("amenity/restaurant", "line")).toBeUndefined();
    expect(getEditablePreset("shop", "point")).toBeUndefined();
    expect(getEditablePreset("does/not/exist", "point")).toBeUndefined();
  });
});

describe("inferEditableWayGeometry", () => {
  it("treats an open way as a line", () => {
    expect(inferEditableWayGeometry({ amenity: "restaurant" }, false)).toBe("line");
  });

  it("honors explicit area tagging", () => {
    expect(inferEditableWayGeometry({ area: "yes", highway: "pedestrian" }, true)).toBe("area");
    expect(inferEditableWayGeometry({ area: "no", amenity: "restaurant" }, true)).toBe("line");
  });

  it("infers area only when every top preset supports area but not line", () => {
    expect(inferEditableWayGeometry({ amenity: "restaurant" }, true)).toBe("area");
    expect(inferEditableWayGeometry({ highway: "residential" }, true)).toBe("line");
  });

  it("returns unknown for closure alone, wildcard presets and dual-geometry presets", () => {
    expect(inferEditableWayGeometry({}, true)).toBe("unknown");
    expect(inferEditableWayGeometry({ building: "yes" }, true)).toBe("unknown");
    expect(inferEditableWayGeometry({ amenity: "post_box" }, true)).toBe("unknown");
  });
});

describe("buildEditableFieldModel", () => {
  const cafeTags = {
    amenity: "cafe",
    name: "Café Central",
    "name:de": "Café Central",
    alt_name: "Central",
    opening_hours: "Mo-Fr 08:00-18:00",
    phone: "+49 30 123456",
    "addr:street": "Hauptstraße",
    "addr:housenumber": "1",
    wheelchair: "limited",
    "some:unknown:tag": "kept",
  };

  it("emits exactly the v1 field allowlist in a stable order", () => {
    const model = buildEditableFieldModel({ tags: cafeTags, geometry: "point" });
    expect(model.fields.map((f) => f.field)).toEqual([
      "name",
      "category",
      "address",
      "openingHours",
      "phone",
      "email",
      "website",
      "wheelchair",
    ]);
  });

  it("owns only the plain name tag and never a localized or alternate name", () => {
    const name = field(cafeTags, "name");
    expect(name?.ownedKeys).toEqual(["name"]);
    expect(name?.kind).toBe("text");
    if (name?.kind !== "text") return;
    expect(name.currentValue).toBe("Café Central");
    expect(name.enabled).toBe(true);
  });

  it("exposes the matched category with its defining keys", () => {
    const category = field(cafeTags, "category");
    expect(category?.enabled).toBe(true);
    expect(category?.ownedKeys).toEqual(["amenity"]);
    if (category?.kind !== "category") return;
    expect(category.currentPresetId).toBe("amenity/cafe");
    expect(category.currentPresetName).toBe("Cafe");
  });

  it("disables the category when the preset is ambiguous or the geometry is unknown", () => {
    const ambiguous = field({ traffic_sign: "maxspeed" }, "category");
    expect(ambiguous?.enabled).toBe(false);
    expect(ambiguous?.disabledReason).toBe("CATEGORY_AMBIGUOUS");
    expect(ambiguous?.ownedKeys).toEqual([]);

    const unknownGeometry = buildEditableFieldModel({
      tags: cafeTags,
      geometry: "unknown",
    }).fields.find((f) => f.field === "category");
    expect(unknownGeometry?.enabled).toBe(false);
    expect(unknownGeometry?.disabledReason).toBe("GEOMETRY_UNKNOWN");

    const lifecycle = field({ "disused:shop": "bakery" }, "category");
    expect(lifecycle?.disabledReason).toBe("LIFECYCLE_STATE");

    const wildcard = field({ shop: "openmapx_unknown_value" }, "category");
    expect(wildcard?.disabledReason).toBe("CATEGORY_UNSUPPORTED");
  });

  it("keeps scalar fields editable even when the category is not", () => {
    const name = field({ "disused:shop": "bakery", name: "Old Bakery" }, "name");
    expect(name?.enabled).toBe(true);
  });

  it("marks only the address keys present on the exact element", () => {
    const address = field(cafeTags, "address");
    expect(address?.enabled).toBe(true);
    if (address?.kind !== "address") return;
    expect(address.entries.map((e) => e.component)).toEqual(["houseNumber", "street"]);
    expect(address.entries.map((e) => e.osmKey)).toEqual(["addr:housenumber", "addr:street"]);
    expect(address.entries[0]?.currentValue).toBe("1");
    expect(address.ownedKeys).toEqual(["addr:housenumber", "addr:street"]);
  });

  it("disables the address group when the element has none", () => {
    const address = field({ amenity: "cafe" }, "address");
    expect(address?.enabled).toBe(false);
    expect(address?.disabledReason).toBe("NO_ADDRESS_ON_ELEMENT");
    expect(address?.ownedKeys).toEqual([]);
    if (address?.kind !== "address") return;
    expect(address.entries).toEqual([]);
  });

  it("localizes address component labels", () => {
    const address = field(cafeTags, "address", "point", "de");
    if (address?.kind !== "address") return;
    expect(address.entries.find((e) => e.component === "houseNumber")?.label).toBe("Hausnummer");
  });

  it("resolves a contact alias when exactly one exists", () => {
    expect(field(cafeTags, "phone")?.ownedKeys).toEqual(["phone"]);
    expect(field({ "contact:phone": "+49 1" }, "phone")?.ownedKeys).toEqual(["contact:phone"]);
    const website = field({ "contact:website": "https://a.example" }, "website");
    expect(website?.ownedKeys).toEqual(["contact:website"]);
    if (website?.kind !== "text") return;
    expect(website.currentValue).toBe("https://a.example");
  });

  it("defaults to the primary alias key when neither exists", () => {
    const email = field({ amenity: "cafe" }, "email");
    expect(email?.ownedKeys).toEqual(["email"]);
    expect(email?.enabled).toBe(true);
    if (email?.kind !== "text") return;
    expect(email.currentValue).toBeNull();
  });

  it("disables a field whose aliases conflict instead of merging them", () => {
    for (const [field_, tags] of [
      ["phone", { phone: "+49 1", "contact:phone": "+49 2" }],
      ["email", { email: "a@b.example", "contact:email": "c@d.example" }],
      ["website", { website: "https://a.example", "contact:website": "https://b.example" }],
    ] as const) {
      const descriptor = field(tags, field_);
      expect(descriptor?.enabled).toBe(false);
      expect(descriptor?.disabledReason).toBe("ALIAS_CONFLICT");
      expect(descriptor?.ownedKeys).toEqual([]);
    }
  });

  it("keeps an unparseable opening-hours value verbatim without interpretation", () => {
    const hours = field({ amenity: "cafe", opening_hours: "not a schedule" }, "openingHours");
    expect(hours?.enabled).toBe(true);
    if (hours?.kind !== "text") return;
    expect(hours.currentValue).toBe("not a schedule");
  });

  it("offers only the schema's wheelchair choices", () => {
    const wheelchair = field(cafeTags, "wheelchair");
    expect(wheelchair?.kind).toBe("choice");
    if (wheelchair?.kind !== "choice") return;
    expect(wheelchair.options.map((o) => o.value)).toEqual(["designated", "yes", "limited", "no"]);
    expect(wheelchair.currentValue).toBe("limited");
    expect(wheelchair.ownedKeys).toEqual(["wheelchair"]);
    const de = field(cafeTags, "wheelchair", "point", "de");
    if (de?.kind !== "choice") return;
    expect(de.options.map((o) => o.label)).toEqual(["Ausgewiesen", "Ja", "Eingeschränkt", "Nein"]);
  });

  it("disables a field whose live value already exceeds the OSM limit", () => {
    const name = field({ amenity: "cafe", name: "a".repeat(256) }, "name");
    expect(name?.enabled).toBe(false);
    expect(name?.disabledReason).toBe("VALUE_TOO_LONG");
  });

  it("returns frozen descriptors", () => {
    const model = buildEditableFieldModel({ tags: cafeTags, geometry: "point" });
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.fields[0])).toBe(true);
  });
});

describe("previewCategoryTransition", () => {
  const tags = {
    amenity: "cafe",
    name: "Café Central",
    "name:de": "Café Central",
    opening_hours: "Mo-Fr 08:00-18:00",
    "some:unknown": "kept",
  };
  const current = matchEditablePreset(tags, "point");

  it("replaces only the defining tag of the old preset", () => {
    const transition = previewCategoryTransition({
      tags,
      current,
      targetPresetId: "amenity/restaurant",
      geometry: "point",
    });
    expect(transition.status).toBe("ok");
    if (transition.status !== "ok") return;
    expect(transition.add).toEqual([]);
    expect(transition.replace).toEqual([{ key: "amenity", from: "cafe", to: "restaurant" }]);
    expect(transition.remove).toEqual([]);
    expect(transition.ownedKeys).toEqual(["amenity"]);
  });

  it("adds and removes defining tags across different keys, in key order", () => {
    const bakery = { shop: "bakery", name: "Brotzeit" };
    const transition = previewCategoryTransition({
      tags: bakery,
      current: matchEditablePreset(bakery, "point"),
      targetPresetId: "amenity/cafe",
      geometry: "point",
    });
    expect(transition.status).toBe("ok");
    if (transition.status !== "ok") return;
    expect(transition.add).toEqual([{ key: "amenity", value: "cafe" }]);
    expect(transition.remove).toEqual([{ key: "shop", value: "bakery" }]);
    expect(transition.ownedKeys).toEqual(["amenity", "shop"]);
  });

  it("never touches unowned, localized or unknown tags", () => {
    const transition = previewCategoryTransition({
      tags,
      current,
      targetPresetId: "amenity/restaurant",
      geometry: "point",
    });
    if (transition.status !== "ok") return;
    const touched = new Set([
      ...transition.add.map((t) => t.key),
      ...transition.replace.map((t) => t.key),
      ...transition.remove.map((t) => t.key),
    ]);
    for (const key of Object.keys(tags)) {
      if (transition.ownedKeys.includes(key)) continue;
      expect(touched.has(key)).toBe(false);
    }
    expect(touched).toEqual(new Set(["amenity"]));
  });

  it("rejects an ambiguous or unsupported current state", () => {
    expect(
      previewCategoryTransition({
        tags: { traffic_sign: "maxspeed" },
        current: matchEditablePreset({ traffic_sign: "maxspeed" }, "point"),
        targetPresetId: "amenity/cafe",
        geometry: "point",
      }),
    ).toEqual({ status: "rejected", reason: "CURRENT_NOT_EDITABLE" });
  });

  it("rejects unknown, wildcard, deprecated, lifecycle and geometry-incompatible targets", () => {
    const cases: Array<[string, string, "point" | "area" | "line"]> = [
      ["does/not/exist", "TARGET_UNKNOWN", "point"],
      ["shop", "TARGET_WILDCARD", "point"],
      ["shop/boutique", "TARGET_DEPRECATED", "point"],
      ["disused/shop", "TARGET_LIFECYCLE", "point"],
      ["highway/residential", "TARGET_GEOMETRY", "point"],
    ];
    for (const [targetPresetId, reason, geometry] of cases) {
      expect(previewCategoryTransition({ tags, current, targetPresetId, geometry })).toEqual({
        status: "rejected",
        reason,
      });
    }
  });

  it("rejects a no-op transition", () => {
    expect(
      previewCategoryTransition({
        tags,
        current,
        targetPresetId: "amenity/cafe",
        geometry: "point",
      }),
    ).toEqual({ status: "rejected", reason: "NO_CHANGE" });
  });

  it("never owns a curated field key, so a category change cannot rewrite one", () => {
    const curated = [
      "name",
      "opening_hours",
      "phone",
      "contact:phone",
      "email",
      "contact:email",
      "website",
      "contact:website",
      "wheelchair",
    ];
    for (const targetPresetId of ["amenity/restaurant", "amenity/fast_food", "shop/bakery"]) {
      const transition = previewCategoryTransition({
        tags,
        current,
        targetPresetId,
        geometry: "point",
      });
      if (transition.status !== "ok") continue;
      for (const key of transition.ownedKeys) {
        expect(curated).not.toContain(key);
        expect(key.startsWith("addr:")).toBe(false);
      }
    }
  });

  it("preserves every non-owned tag when the transition is applied", () => {
    const transition = previewCategoryTransition({
      tags,
      current,
      targetPresetId: "amenity/restaurant",
      geometry: "point",
    });
    if (transition.status !== "ok") return;
    const result: Record<string, string> = { ...tags };
    for (const entry of transition.remove) delete result[entry.key];
    for (const entry of transition.replace) result[entry.key] = entry.to;
    for (const entry of transition.add) result[entry.key] = entry.value;
    for (const [key, value] of Object.entries(tags)) {
      if (transition.ownedKeys.includes(key)) continue;
      expect(result[key]).toBe(value);
    }
    expect(Object.keys(result).sort()).toEqual(Object.keys(tags).sort());
  });
});
