import type { OsmFieldChange } from "@openmapx/core";
import { describe, expect, it } from "vitest";
import { applyOsmFieldChanges, buildContextFields } from "../tag-policy.js";
import { isOsmContributionError, type OsmElement } from "../types.js";

const BASE_TAGS = {
  amenity: "cafe",
  name: "Café Central",
  "name:de": "Café Central",
  alt_name: "Central",
  official_name: "Café Central GmbH",
  opening_hours: "Mo-Fr 08:00-18:00",
  phone: "+49 30 123456",
  website: "https://cafe.example",
  "addr:street": "Hauptstraße",
  "addr:housenumber": "1",
  wheelchair: "limited",
  "survey:date": "2025-01-01",
  "openmapx:unknown": "preserve me",
};

function node(tags: Record<string, string> = BASE_TAGS): OsmElement {
  return {
    type: "node",
    id: 12,
    version: 4,
    lat: 52.5,
    lon: 13.4,
    visible: true,
    changeset: 800,
    tags: { ...tags },
  };
}

function apply(changes: OsmFieldChange[], element: OsmElement = node(), changesetId = 900) {
  return applyOsmFieldChanges({
    baseElement: element,
    geometry: "point",
    changes,
    locale: "en",
    changesetId,
  });
}

function expectRejection(changes: OsmFieldChange[], code: string, element?: OsmElement) {
  let thrown: unknown;
  try {
    apply(changes, element);
  } catch (error) {
    thrown = error;
  }
  expect(isOsmContributionError(thrown)).toBe(true);
  expect((thrown as { code: string }).code).toBe(code);
}

describe("scalar edits", () => {
  it("sets the name and leaves every other tag byte-identical", () => {
    const { element, preview } = apply([{ field: "name", action: "set", value: "Café Zentral" }]);
    expect(element.tags.name).toBe("Café Zentral");
    for (const [key, value] of Object.entries(BASE_TAGS)) {
      if (key === "name") continue;
      expect(element.tags[key]).toBe(value);
    }
    expect(preview.tagDiff).toEqual({
      add: [],
      replace: [{ key: "name", from: "Café Central", to: "Café Zentral" }],
      remove: [],
    });
    expect(preview.changes).toEqual([
      {
        field: "name",
        label: "Name",
        action: "set",
        before: "Café Central",
        after: "Café Zentral",
      },
    ]);
  });

  it("never touches a localized or alternate name", () => {
    const { element } = apply([{ field: "name", action: "set", value: "New" }]);
    expect(element.tags["name:de"]).toBe("Café Central");
    expect(element.tags.alt_name).toBe("Central");
    expect(element.tags.official_name).toBe("Café Central GmbH");
  });

  it("removes only the one resolved owned key", () => {
    const { element, preview } = apply([{ field: "phone", action: "remove" }]);
    expect(element.tags.phone).toBeUndefined();
    expect(element.tags.website).toBe("https://cafe.example");
    expect(preview.tagDiff.remove).toEqual([{ key: "phone", value: "+49 30 123456" }]);
    expect(preview.warnings).toContain("VALUE_REMOVED");
  });

  it("writes a contact alias back to the key that already exists", () => {
    const element = node({ amenity: "cafe", "contact:phone": "+49 1" });
    const result = apply([{ field: "phone", action: "set", value: "+49 2" }], element);
    expect(result.element.tags["contact:phone"]).toBe("+49 2");
    expect(result.element.tags.phone).toBeUndefined();
  });

  it("uses the primary key when neither alias exists", () => {
    const element = node({ amenity: "cafe" });
    const result = apply([{ field: "email", action: "set", value: "hi@cafe.example" }], element);
    expect(result.element.tags.email).toBe("hi@cafe.example");
    expect(result.preview.tagDiff.add).toEqual([{ key: "email", value: "hi@cafe.example" }]);
  });

  it("refuses to edit a field whose aliases conflict", () => {
    const element = node({ amenity: "cafe", phone: "+49 1", "contact:phone": "+49 2" });
    expectRejection(
      [{ field: "phone", action: "set", value: "+49 3" }],
      "FIELD_NOT_EDITABLE",
      element,
    );
  });

  it("refuses to remove a field that has no current value", () => {
    const element = node({ amenity: "cafe" });
    expectRejection([{ field: "phone", action: "remove" }], "INVALID_CHANGE", element);
  });

  it("rejects a no-op set", () => {
    expectRejection([{ field: "name", action: "set", value: "Café Central" }], "EMPTY_CHANGE");
  });

  it("rejects an empty change list and duplicate fields", () => {
    expectRejection([], "EMPTY_CHANGE");
    expectRejection(
      [
        { field: "name", action: "set", value: "A" },
        { field: "name", action: "remove" },
      ],
      "INVALID_CHANGE",
    );
  });
});

describe("field validation", () => {
  it("trims outer whitespace but never transliterates or title-cases", () => {
    const { element } = apply([{ field: "name", action: "set", value: "  cafe zentral  " }]);
    expect(element.tags.name).toBe("cafe zentral");
  });

  it("enforces the 255 code-point limit by code points, not UTF-16 units", () => {
    const astral = "😀";
    expect(() =>
      apply([{ field: "name", action: "set", value: astral.repeat(255) }]),
    ).not.toThrow();
    expectRejection(
      [{ field: "name", action: "set", value: astral.repeat(256) }],
      "INVALID_CHANGE",
    );
  });

  it("validates opening hours syntactically and keeps the trimmed input", () => {
    const { element } = apply([
      { field: "openingHours", action: "set", value: "  Tu-Su 10:00-22:00  " },
    ]);
    expect(element.tags.opening_hours).toBe("Tu-Su 10:00-22:00");
    expectRejection(
      [{ field: "openingHours", action: "set", value: "every other tuesday maybe" }],
      "INVALID_CHANGE",
    );
  });

  it("accepts conservative phone numbers and rejects the rest", () => {
    for (const value of ["+49 30 654321", "030 12-34/56", "+1 (555) 010-4567", "112;110"]) {
      expect(() => apply([{ field: "phone", action: "set", value }])).not.toThrow();
    }
    for (const value of ["ring the bell", "+49", "12", "+49 30 <b>"]) {
      expectRejection([{ field: "phone", action: "set", value }], "INVALID_CHANGE");
    }
  });

  it("accepts one or more semicolon-separated emails and rejects malformed ones", () => {
    for (const value of ["a@b.example", "a@b.example;c@d.example"]) {
      expect(() => apply([{ field: "email", action: "set", value }])).not.toThrow();
    }
    for (const value of ["not an email", "a@b", "a b@c.example", "a@b.example;", "@b.example"]) {
      expectRejection([{ field: "email", action: "set", value }], "INVALID_CHANGE");
    }
  });

  it("requires an absolute HTTP(S) website and keeps the visible input", () => {
    const { element } = apply([
      { field: "website", action: "set", value: " https://Cafe.example/menu " },
    ]);
    // Validated with URL, but not silently canonicalized.
    expect(element.tags.website).toBe("https://Cafe.example/menu");
    for (const value of [
      "cafe.example",
      "javascript:alert(1)",
      "ftp://cafe.example",
      "https://user:pw@cafe.example",
    ]) {
      expectRejection([{ field: "website", action: "set", value }], "INVALID_CHANGE");
    }
  });

  it("accepts only the schema's wheelchair choices", () => {
    for (const value of ["designated", "yes", "limited", "no"]) {
      const element = node({ ...BASE_TAGS, wheelchair: "yes" });
      if (value === "yes") continue;
      expect(() => apply([{ field: "wheelchair", action: "set", value }], element)).not.toThrow();
    }
    expectRejection([{ field: "wheelchair", action: "set", value: "maybe" }], "INVALID_CHANGE");
  });
});

describe("address edits", () => {
  it("patches only keys already present on the exact element", () => {
    const { element, preview } = apply([
      {
        field: "address",
        action: "patch",
        value: {
          houseNumber: { action: "set", value: "1a" },
          street: { action: "remove" },
        },
      },
    ]);
    expect(element.tags["addr:housenumber"]).toBe("1a");
    expect(element.tags["addr:street"]).toBeUndefined();
    expect(preview.tagDiff.replace).toEqual([{ key: "addr:housenumber", from: "1", to: "1a" }]);
    expect(preview.tagDiff.remove).toEqual([{ key: "addr:street", value: "Hauptstraße" }]);
  });

  it("refuses to introduce an address group that does not exist", () => {
    const element = node({ amenity: "cafe", name: "Café" });
    expectRejection(
      [{ field: "address", action: "patch", value: { city: { action: "set", value: "Berlin" } } }],
      "FIELD_NOT_EDITABLE",
      element,
    );
  });

  it("refuses to add an address component the element does not already have", () => {
    expectRejection(
      [{ field: "address", action: "patch", value: { city: { action: "set", value: "Berlin" } } }],
      "FIELD_NOT_EDITABLE",
    );
  });
});

describe("category transitions", () => {
  it("applies only the defining tags of the reviewed transition", () => {
    const { element, preview } = apply([
      { field: "category", action: "set", presetId: "amenity/restaurant" },
    ]);
    expect(element.tags.amenity).toBe("restaurant");
    expect(element.tags.name).toBe("Café Central");
    expect(element.tags["openmapx:unknown"]).toBe("preserve me");
    expect(preview.tagDiff.replace).toEqual([{ key: "amenity", from: "cafe", to: "restaurant" }]);
    expect(preview.warnings).toContain("CATEGORY_TRANSITION");
    expect(preview.requiresReview).toBe(true);
  });

  it("refuses an ambiguous current category", () => {
    const element = node({ traffic_sign: "maxspeed" });
    expectRejection(
      [{ field: "category", action: "set", presetId: "amenity/cafe" }],
      "FIELD_NOT_EDITABLE",
      element,
    );
  });

  it("refuses a wildcard, deprecated or geometry-incompatible target", () => {
    for (const presetId of ["shop", "shop/boutique", "highway/residential", "does/not/exist"]) {
      expectRejection([{ field: "category", action: "set", presetId }], "INVALID_CHANGE");
    }
  });

  it("refuses a lifecycle-tagged element entirely", () => {
    const element = node({ "disused:shop": "bakery", name: "Old" });
    expectRejection(
      [{ field: "category", action: "set", presetId: "amenity/cafe" }],
      "FIELD_NOT_EDITABLE",
      element,
    );
  });
});

describe("structural preservation", () => {
  it("keeps node coordinates and visibility", () => {
    const { element } = apply([{ field: "name", action: "set", value: "New" }]);
    expect(element).toMatchObject({
      type: "node",
      id: 12,
      version: 4,
      changeset: 900,
      lat: 52.5,
      lon: 13.4,
      visible: true,
    });
  });

  it("keeps every ordered way node reference", () => {
    const way: OsmElement = {
      type: "way",
      id: 42,
      version: 2,
      nodes: [5, 6, 7, 5],
      tags: { amenity: "cafe", name: "Old" },
    };
    const { element } = applyOsmFieldChanges({
      baseElement: way,
      geometry: "area",
      changes: [{ field: "name", action: "set", value: "New" }],
      locale: "en",
      changesetId: 1,
    });
    expect(element).toMatchObject({ type: "way", nodes: [5, 6, 7, 5] });
  });

  it("keeps every ordered relation member and role", () => {
    const relation: OsmElement = {
      type: "relation",
      id: 7,
      version: 2,
      members: [
        { type: "way", ref: 1, role: "outer" },
        { type: "node", ref: 2, role: "" },
      ],
      tags: { type: "multipolygon", name: "Old" },
    };
    const { element } = applyOsmFieldChanges({
      baseElement: relation,
      geometry: "relation",
      changes: [{ field: "name", action: "set", value: "New" }],
      locale: "en",
      changesetId: 1,
    });
    expect(element).toMatchObject({
      type: "relation",
      members: [
        { type: "way", ref: 1, role: "outer" },
        { type: "node", ref: 2, role: "" },
      ],
    });
  });

  it("changes only keys the operation owns, for every fixture change", () => {
    const cases: OsmFieldChange[][] = [
      [{ field: "name", action: "set", value: "New" }],
      [{ field: "phone", action: "remove" }],
      [{ field: "category", action: "set", presetId: "amenity/restaurant" }],
      [{ field: "wheelchair", action: "set", value: "yes" }],
      [
        {
          field: "address",
          action: "patch",
          value: { houseNumber: { action: "set", value: "2" } },
        },
      ],
    ];
    for (const changes of cases) {
      const { element, preview } = apply(changes);
      const touched = new Set([
        ...preview.tagDiff.add.map((t) => t.key),
        ...preview.tagDiff.replace.map((t) => t.key),
        ...preview.tagDiff.remove.map((t) => t.key),
      ]);
      for (const [key, value] of Object.entries(BASE_TAGS)) {
        if (touched.has(key)) continue;
        expect(element.tags[key]).toBe(value);
      }
      for (const key of Object.keys(element.tags)) {
        if (touched.has(key)) continue;
        expect(BASE_TAGS[key as keyof typeof BASE_TAGS]).toBe(element.tags[key]);
      }
    }
  });

  it("never returns the complete raw tag map in the preview", () => {
    const { preview } = apply([{ field: "name", action: "set", value: "New" }]);
    expect(JSON.stringify(preview)).not.toContain("openmapx:unknown");
    expect(JSON.stringify(preview)).not.toContain("survey:date");
  });
});

describe("buildContextFields", () => {
  it("maps the preset field model onto the public contract", () => {
    const fields = buildContextFields(BASE_TAGS, "point", "en");
    expect(fields.map((f) => f.field)).toEqual([
      "name",
      "category",
      "address",
      "openingHours",
      "phone",
      "email",
      "website",
      "wheelchair",
    ]);
    const name = fields.find((f) => f.field === "name");
    expect(name).toMatchObject({ kind: "text", currentValue: "Café Central", enabled: true });
    const address = fields.find((f) => f.field === "address");
    expect(address).toMatchObject({ kind: "address", enabled: true });
    const wheelchair = fields.find((f) => f.field === "wheelchair");
    expect(wheelchair).toMatchObject({ kind: "choice", currentValue: "limited" });
  });

  it("carries closed disabled reasons and no OSM key", () => {
    const fields = buildContextFields({ amenity: "cafe" }, "point", "en");
    const address = fields.find((f) => f.field === "address");
    expect(address?.enabled).toBe(false);
    expect(address?.disabledReason).toBe("NO_ADDRESS_ON_ELEMENT");
    expect(JSON.stringify(fields)).not.toContain("addr:");
    expect(JSON.stringify(fields)).not.toContain("contact:");
  });

  it("localizes labels", () => {
    const fields = buildContextFields(BASE_TAGS, "point", "de");
    expect(fields.find((f) => f.field === "openingHours")?.label).toBe("Öffnungszeiten");
  });
});
