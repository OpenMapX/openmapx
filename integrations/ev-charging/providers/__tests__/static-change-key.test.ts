import { resolvePoiSourceId } from "@openmapx/poi-source-registry";
import { describe, expect, it } from "vitest";
import { declarePoiSources } from "../../poi-sources.js";

describe("EV static publication reuse opt-in", () => {
  it("only opts in the two reviewed national static sources with complete row keys", () => {
    const sources = declarePoiSources();
    expect(
      sources.filter((s) => s.static?.staticChangeKey).map((s) => resolvePoiSourceId(s).id),
    ).toEqual(["de-bnetza", "de-ocpdb"]);
    for (const source of sources.filter((s) => s.static?.staticChangeKey)) {
      const key = source.static?.staticChangeKey;
      const row = { poiId: "a", lng: 6, lat: 50, payload: { tariff: 1 } };
      expect(key?.([row])).not.toBe(key?.([{ ...row, lng: 7 }]));
      expect(key?.([row])).not.toBe(key?.([{ ...row, payload: { tariff: 2 } }]));
    }
    expect(sources.find((s) => resolvePoiSourceId(s).id === "de-ocpdb")?.live?.ttlSeconds).toBe(
      7200,
    );
  });
});
