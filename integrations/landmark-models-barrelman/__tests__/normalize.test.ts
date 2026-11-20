import type { Attribution } from "@openmapx/integration-framework";
import { assetRecordSchema } from "@openmapx/open-landmarks-client";
import { describe, expect, it } from "vitest";
import { fixtureRecord } from "../../../packages/open-landmarks-client/__tests__/fixtures";
import { normalizeBarrelmanAsset } from "../normalize";

const receipts: Attribution[] = [
  { sourceId: "barrelman-landmarks", name: "Landmarks (Barrelman)" },
  { sourceId: "openstreetmap", name: "OpenStreetMap" },
];

function asset(id: string, change?: (raw: Record<string, unknown>) => void) {
  const raw = fixtureRecord("barrelman-assets.json", id);
  change?.(raw);
  return normalizeBarrelmanAsset(assetRecordSchema.parse(raw), receipts);
}

describe("normalizeBarrelmanAsset", () => {
  it("maps reviewStatus to review tiers", () => {
    const tier = (status: string | undefined) =>
      asset("30-rockefeller-plaza", (raw) => {
        if (status === undefined) delete raw.reviewStatus;
        else raw.reviewStatus = status;
      })?.reviewTier;
    expect(tier("unreviewed")).toBe("unreviewed");
    expect(tier("draft")).toBe("unreviewed");
    expect(tier(undefined)).toBe("unreviewed");
    expect(tier("reviewed")).toBe("approved");
  });

  it("allows derived footprints only for building-like types", () => {
    const allowed = (type: string | undefined) =>
      asset("30-rockefeller-plaza", (raw) => {
        if (type === undefined) delete raw.type;
        else raw.type = type;
      })?.derivedFootprintAllowed;
    expect(allowed("bridge")).toBe(false);
    expect(allowed("sculpture")).toBe(false);
    expect(allowed("ride")).toBe(false);
    expect(allowed("stadium")).toBe(true);
    expect(allowed("building")).toBe(true);
    expect(allowed(undefined)).toBe(true);
  });

  it("uses footprint-minimum grounding and the Barrelman source", () => {
    const result = asset("30-rockefeller-plaza");
    expect(result?.grounding).toBe("footprint-minimum");
    expect(result?.sourceId).toBe("barrelman-landmarks");
    expect(result?.contributors).toEqual(receipts);
  });

  it("keeps negative elevation", () => {
    expect(asset("dal-att-stadium")?.elevationM).toBe(-15);
  });

  it("keeps an asset without osm refs with an empty replaces", () => {
    const result = asset("ascendus");
    expect(result).not.toBeNull();
    expect(result?.replaces).toEqual([]);
  });
});
