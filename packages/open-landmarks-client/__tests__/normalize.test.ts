import { describe, expect, it } from "vitest";
import { cleanAttributionText, commonAssetFields, resolveUpstreamUrl } from "../normalize";
import { assetRecordSchema, type OpenLandmarksAssetRecord } from "../schema";
import { fixtureRecord } from "./fixtures";

function record(
  file: "barrelman-assets.json" | "open-landmarks-assets.json",
  id: string,
  change?: (raw: Record<string, unknown>) => void,
): OpenLandmarksAssetRecord {
  const raw = fixtureRecord(file, id);
  change?.(raw);
  return assetRecordSchema.parse(raw);
}

const MIB = 1024 * 1024;

describe("commonAssetFields", () => {
  it("keeps osm order and caps refs at 256", () => {
    const fields = commonAssetFields(
      record("barrelman-assets.json", "30-rockefeller-plaza", (raw) => {
        const extra = Array.from({ length: 300 }, (_, i) => ({
          type: "way",
          id: 1_000_000 + i,
          url: "https://www.openstreetmap.org/way/1",
        }));
        raw.additionalOsm = [...(raw.additionalOsm as unknown[]), ...extra];
      }),
    );
    expect(fields?.replaces[0]).toBe("way/487519790");
    expect(fields?.replaces).toHaveLength(256);
    expect(new Set(fields?.replaces).size).toBe(256);
  });

  it("drops a record whose heading is not 0", () => {
    expect(
      commonAssetFields(
        record("barrelman-assets.json", "30-rockefeller-plaza", (raw) => {
          raw.heading = 12;
        }),
      ),
    ).toBeNull();
  });

  it("drops a record with axes other than the v1 frame", () => {
    expect(
      commonAssetFields(
        record("barrelman-assets.json", "30-rockefeller-plaza", (raw) => {
          raw.axes = "X east / Y north / Z up";
        }),
      ),
    ).toBeNull();
  });

  it("drops a low LOD over 2 MiB", () => {
    expect(
      commonAssetFields(
        record("barrelman-assets.json", "30-rockefeller-plaza", (raw) => {
          (raw.lods as { low: { bytes: number } }).low.bytes = 2 * MIB + 1;
        }),
      ),
    ).toBeNull();
  });

  it("drops only an oversize detail LOD", () => {
    const fields = commonAssetFields(
      record("barrelman-assets.json", "abu-dhabi-louvre", (raw) => {
        (raw.lods as { detail: { bytes: number } }).detail.bytes = 4 * MIB + 1;
      }),
    );
    expect(fields).not.toBeNull();
    expect(fields?.lods.detail).toBeUndefined();
    expect(fields?.detailZoom).toBeUndefined();
  });

  it("defaults minZoom to 14 and clamps to [13,18]", () => {
    const zoom = (value: unknown) =>
      commonAssetFields(
        record("barrelman-assets.json", "30-rockefeller-plaza", (raw) => {
          if (value === undefined) delete raw.minZoom;
          else raw.minZoom = value;
        }),
      )?.minZoom;
    expect(zoom(undefined)).toBe(14);
    expect(zoom(9)).toBe(13);
    expect(zoom(20)).toBe(18);
    expect(zoom(15)).toBe(15);
  });

  it("defaults detailZoom to 17 only with a detail LOD", () => {
    const withDetail = commonAssetFields(
      record("barrelman-assets.json", "abu-dhabi-louvre", (raw) => {
        delete raw.detailZoom;
      }),
    );
    expect(withDetail?.detailZoom).toBe(17);
    expect(
      commonAssetFields(record("barrelman-assets.json", "30-rockefeller-plaza"))?.detailZoom,
    ).toBeUndefined();
  });

  it("maps replacementFootprint to footprint", () => {
    const fields = commonAssetFields(record("open-landmarks-assets.json", "arc-de-triomphe"));
    expect(fields?.footprint?.type).toBe("Polygon");
  });

  it("maps model files, elevation and height", () => {
    const fields = commonAssetFields(record("barrelman-assets.json", "dal-att-stadium"));
    expect(fields?.elevationM).toBe(-15);
    expect(fields?.heightM).toBeGreaterThan(0);
    expect(fields?.lods.low.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fields?.lods.low.gzipBytes).toBeGreaterThan(0);
    expect(fields?.anchor).toHaveLength(2);
    expect(fields?.providerAssetId).toBe("dal-att-stadium");
  });
});

describe("cleanAttributionText", () => {
  it('removes a trailing "; undefined"', () => {
    const raw = fixtureRecord("open-landmarks-assets.json", "conservatory-of-flowers")
      .attribution as string;
    expect(raw.endsWith("; undefined")).toBe(true);
    const cleaned = cleanAttributionText(raw);
    expect(cleaned.endsWith("undefined")).toBe(false);
    expect(raw.startsWith(cleaned)).toBe(true);
  });
});

describe("resolveUpstreamUrl", () => {
  it("resolves root-relative paths and refuses other hosts", () => {
    expect(resolveUpstreamUrl("https://landmarks.barrelman.dev", "/api/v1/latest.json")).toBe(
      "https://landmarks.barrelman.dev/api/v1/latest.json",
    );
    expect(
      resolveUpstreamUrl(
        "https://landmarks.barrelman.dev",
        "https://landmarks.barrelman.dev/models/a.glb",
      ),
    ).toBe("https://landmarks.barrelman.dev/models/a.glb");
    expect(() =>
      resolveUpstreamUrl("https://landmarks.barrelman.dev", "https://evil.example/x"),
    ).toThrow();
  });
});
