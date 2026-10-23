import { OPENSTREETMAP_ATTRIBUTION } from "@openmapx/mobility-core/attribution";
import { describe, expect, it } from "vitest";
import { routeJsonSchema } from "../schema";
import {
  savedCreateListSchema,
  savedFieldContributorsSchema,
  savedImportSchema,
  savedLabelWrittenSchema,
  savedListCreatedSchema,
  savedListSchema,
  savedOkSchema,
  savedOperations,
  savedUpdateListSchema,
} from "./saved";

describe("canonical saved wire shapes", () => {
  it("distinguishes creation receipts and acknowledgements from complete list records", () => {
    const created = { id: "list", name: "Trip", icon: null, isPrivate: true };
    expect(savedListCreatedSchema.safeParse(created).success).toBe(true);
    expect(savedListSchema.safeParse(created).success).toBe(false);
    expect(
      savedListSchema.safeParse({
        ...created,
        sortOrder: 0,
        placeCount: 0,
        createdAt: "2026-10-01T00:00:00Z",
        updatedAt: "2026-10-01T00:00:00Z",
      }).success,
    ).toBe(true);
    expect(savedOkSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(savedLabelWrittenSchema.safeParse({ id: "label", label: "home" }).success).toBe(true);
    expect(savedListCreatedSchema.safeParse({ ok: true }).success).toBe(false);
  });
  it("retains complete captured licence policy and authoritative empty field receipts", () => {
    const capture = { name: [OPENSTREETMAP_ATTRIBUTION], lat: [], lng: [] };
    expect(savedFieldContributorsSchema.parse(capture)).toEqual(capture);
    expect(savedFieldContributorsSchema.parse({})).toEqual({});
    expect(
      savedFieldContributorsSchema.safeParse({
        name: [{ sourceId: "x", name: "X", license: "invented" }],
      }).success,
    ).toBe(false);
    expect(savedFieldContributorsSchema.safeParse({ phone: [] }).success).toBe(false);
  });
  it("enforces receipt counts and UTF-8 capture byte budget", () => {
    expect(
      savedFieldContributorsSchema.safeParse({
        name: Array.from({ length: 33 }, () => ({ sourceId: "x", name: "X" })),
      }).success,
    ).toBe(false);
    expect(
      savedFieldContributorsSchema.safeParse({
        name: [{ sourceId: "x", name: "X", notes: "é".repeat(40_000) }],
      }).success,
    ).toBe(false);
  });
  it("requires exactly one import destination, bounded batches and valid coordinates", () => {
    const places = [{ name: "Cafe", lat: 52, lng: 13 }];
    expect(savedImportSchema.safeParse({ target: { name: "Trip" }, places }).success).toBe(true);
    for (const target of [{}, { name: "Trip", listId: "list" }])
      expect(savedImportSchema.safeParse({ target, places }).success).toBe(false);
    expect(savedImportSchema.safeParse({ target: { listId: "list" }, places: [] }).success).toBe(
      false,
    );
    expect(
      savedImportSchema.safeParse({
        target: { listId: "list" },
        places: [{ name: "Cafe", lat: 91, lng: 13 }],
      }).success,
    ).toBe(false);
  });
  it("models null icon clearing while rejecting string coercion and unknown import keys", () => {
    expect(savedUpdateListSchema.parse({ icon: null })).toEqual({ icon: null });
    expect(savedCreateListSchema.safeParse({ name: "Trip", isPrivate: "false" }).success).toBe(
      false,
    );
    expect(
      savedImportSchema.safeParse({
        target: { name: "Trip" },
        places: [{ name: "Cafe", lat: 52, lng: 13 }],
        extra: true,
      }).success,
    ).toBe(false);
  });
  it("emits closed structured schemas with licence metadata rather than a broad custom object", () => {
    const schema = routeJsonSchema(savedFieldContributorsSchema, {
      identity: "saved",
      io: "input",
    });
    expect(schema.type).toBe("object");
    expect(schema.additionalProperties).toBe(false);
    expect(JSON.stringify(schema)).toContain("compactText");
    expect(JSON.stringify(schema)).toContain('"maxItems":32');
    expect(Object.values(savedOperations)).toHaveLength(14);
  });
});

it("can emit reused saved receipt structures as references without changing their wire schema", () => {
  const schema = routeJsonSchema(savedFieldContributorsSchema, {
    identity: "saved",
    io: "input",
    reused: "ref",
  });
  expect(schema.definitions).toBeDefined();
  const properties = schema.properties as Record<string, { $ref: string }>;
  const definitions = schema.definitions as Record<string, { items: { $ref: string } }>;
  const name = definitions[properties.name.$ref.split("/").at(-1) ?? ""];
  const latitude = definitions[properties.lat.$ref.split("/").at(-1) ?? ""];
  expect(name.items.$ref).toBeTruthy();
  expect(latitude.items.$ref).toBe(name.items.$ref);
});
