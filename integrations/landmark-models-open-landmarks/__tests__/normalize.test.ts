import type { Attribution } from "@openmapx/integration-framework";
import { assetRecordSchema } from "@openmapx/open-landmarks-client";
import { describe, expect, it } from "vitest";
import { fixtureRecord } from "../../../packages/open-landmarks-client/__tests__/fixtures";
import manifest from "../manifest.json";
import { normalizeOpenLandmarksAsset } from "../normalize";

const osm: Attribution = { sourceId: "openstreetmap", name: "OpenStreetMap" };
const receipts: Attribution[] = [{ sourceId: "open-landmarks", name: "Open Landmarks" }, osm];

function asset(id: string, change?: (raw: Record<string, unknown>) => void) {
  const raw = fixtureRecord("open-landmarks-assets.json", id);
  change?.(raw);
  return normalizeOpenLandmarksAsset(assetRecordSchema.parse(raw), receipts);
}

const rightsApproved = (raw: Record<string, unknown>) => {
  raw.rightsStatus = "approved";
};

describe("normalizeOpenLandmarksAsset", () => {
  it("drops records whose rightsStatus is not approved", () => {
    expect(asset("london-eye")).toBeNull();
    expect(asset("alcatraz-cellhouse")).toBeNull();
    expect(asset("arc-de-triomphe")).not.toBeNull();
  });

  it("skips bridge, terrain-component and terrain-placement assets", () => {
    expect(
      asset("arc-de-triomphe", (raw) => {
        raw.bridgeReplacement = { sourceLayer: "roads" };
      }),
    ).toBeNull();
    expect(
      asset("arc-de-triomphe", (raw) => {
        raw.terrainComponents = { components: [] };
      }),
    ).toBeNull();
    expect(
      asset("arc-de-triomphe", (raw) => {
        raw.terrainPlacement = { datum: "sea-level" };
      }),
    ).toBeNull();
    expect(asset("golden-gate-bridge", rightsApproved)).toBeNull();
    expect(asset("painted-ladies", rightsApproved)).toBeNull();
  });

  it("maps approved to approved and the rest to draft", () => {
    expect(asset("arc-de-triomphe")?.reviewTier).toBe("approved");
    expect(
      asset("arc-de-triomphe", (raw) => {
        raw.approved = false;
      })?.reviewTier,
    ).toBe("draft");
  });

  it("uses anchor grounding and the replacement footprint", () => {
    const result = asset("arc-de-triomphe");
    expect(result?.grounding).toBe("anchor");
    expect(result?.derivedFootprintAllowed).toBe(false);
    expect(result?.footprint?.type).toBe("Polygon");
    expect(result?.sourceId).toBe("open-landmarks");
  });

  it("builds a CC BY-SA 3.0 receipt for the Eiffel Tower with its imported-source attribution text", () => {
    const [model, placement] = asset("eiffel-tower")?.contributors ?? [];
    expect(model).toMatchObject({
      sourceId: "open-landmarks",
      name: "Tour Eiffel",
      url: "https://open-landmarks.benmaps.fr/landmarks/eiffel-tower/",
      publisher: { name: "Newcandle from Thingiverse, Open Landmarks contributors (adaptation)" },
    });
    expect(model?.attributionText).toContain("Newcandle from Thingiverse");
    expect(model?.licensing?.bindings[0]?.license).toEqual({
      kind: "spdx",
      expression: "CC-BY-SA-3.0",
    });
    expect(placement).toEqual(osm);
  });

  it('strips "; undefined" from attribution text', () => {
    const text = asset("conservatory-of-flowers", rightsApproved)?.contributors[0]?.attributionText;
    expect(text).toBeTruthy();
    expect(text?.endsWith("undefined")).toBe(false);
  });

  it("copies the compact attribution policy into each receipt", () => {
    const policy = (
      manifest.dataSources[0]?.licensing.bindings[0] as
        | { attribution?: { compactText?: string } }
        | undefined
    )?.attribution;
    expect(policy?.compactText).toBe("3D models: Open Landmarks (CC BY 4.0 and others)");
    const binding = asset("arc-de-triomphe")?.contributors[0]?.licensing?.bindings[0];
    expect(binding?.attribution).toEqual(policy);
  });
});
