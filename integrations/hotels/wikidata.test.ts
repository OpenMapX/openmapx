import { beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "./__fixtures__/wikidata-windsor-palace.json" with { type: "json" };
import { parseWikidataOtaIds, resolveWikidataOtaIds } from "./wikidata.js";

const fetchJson = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@openmapx/core")>()),
  fetchJson,
}));

describe("parseWikidataOtaIds", () => {
  it("extracts the OTA ids present on the entity (real captured values)", () => {
    const ids = parseWikidataOtaIds(fixture, "Q12231151");
    expect(ids.expedia).toBe("h7172034"); // P5651
    expect(ids.booking).toBe("eg/windsor-palace"); // P3607
    expect(ids.hotelscom).toBe("ho326672"); // P3898
    expect(ids.agoda).toBe("paradise-inn-windsor-palace-hotel/hotel/alexandria-eg"); // P6008 slug
    expect(ids.tripcom).toBe("2565026"); // P10425
  });
  it("returns an empty object for an entity with no OTA ids", () => {
    expect(parseWikidataOtaIds({ entities: { Q1: { claims: {} } } }, "Q1")).toEqual({});
  });
  it("ignores a missing entity safely", () => {
    expect(parseWikidataOtaIds({ entities: {} }, "Q1")).toEqual({});
  });
});

describe("resolveWikidataOtaIds", () => {
  beforeEach(() => fetchJson.mockReset());

  it("answers an empty result for an invalid qid without a request", async () => {
    expect(await resolveWikidataOtaIds("12231151")).toEqual({});
    expect(fetchJson).not.toHaveBeenCalled();
  });

  it("reads the entity document and parses its OTA ids", async () => {
    fetchJson.mockResolvedValue(fixture);
    const ids = await resolveWikidataOtaIds("Q12231151");
    expect(ids?.booking).toBe("eg/windsor-palace");
    expect(fetchJson).toHaveBeenCalledWith(
      "https://www.wikidata.org/wiki/Special:EntityData/Q12231151.json",
      expect.objectContaining({ nullOnError: true, timeoutMs: 5000 }),
    );
  });

  it("answers null for a transient failure so the caller does not cache it", async () => {
    fetchJson.mockResolvedValue(null);
    expect(await resolveWikidataOtaIds("Q1")).toBeNull();
  });
});
