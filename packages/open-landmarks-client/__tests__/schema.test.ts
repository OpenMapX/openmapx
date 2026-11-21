import { describe, expect, it } from "vitest";
import { assetRecordSchema, assetsDocumentSchema, catalogueSchema, pointerSchema } from "../schema";
import { fixture, fixtureRecord } from "./fixtures";

describe("Open Landmarks v1 schemas", () => {
  it("parses both live-shaped assets documents", () => {
    for (const file of ["barrelman-assets.json", "open-landmarks-assets.json"]) {
      const parsed = assetsDocumentSchema.safeParse(fixture(file));
      expect(parsed.success, file).toBe(true);
      for (const record of (parsed.data?.assets ?? []) as unknown[]) {
        expect(assetRecordSchema.safeParse(record).success).toBe(true);
      }
    }
  });

  it("parses both pointers and catalogues", () => {
    for (const name of ["barrelman", "open-landmarks"]) {
      expect(pointerSchema.safeParse(fixture(`${name}-pointer.json`)).success).toBe(true);
      expect(catalogueSchema.safeParse(fixture(`${name}-catalogue.json`)).success).toBe(true);
    }
  });

  it("rejects a record without anchor", () => {
    const record = fixtureRecord("barrelman-assets.json", "30-rockefeller-plaza");
    delete record.anchor;
    expect(assetRecordSchema.safeParse(record).success).toBe(false);
  });

  it("parses a no-release pointer", () => {
    const parsed = pointerSchema.safeParse({
      schemaVersion: 1,
      channel: "approved",
      status: "no-release",
      release: null,
      catalogue: null,
      count: 0,
    });
    expect(parsed.success).toBe(true);
  });
});
