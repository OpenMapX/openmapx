import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maptilerGeocodingService,
  setMaptilerApiKey,
} from "../../../integrations/geocoding-maptiler/provider.js";
import { extractTerms } from "../../../services/data-manager/src/jobs/search-index/terms.js";

function read(name: string) {
  return JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
}
const queries = read("queries-v1.json");
const responses = read("responses-v1.json");
const sources = read("sources-v1.json");

afterEach(() => {
  setMaptilerApiKey(undefined);
  vi.unstubAllGlobals();
});

describe("business name/address adapter regression corpus", () => {
  for (const entry of responses.cases) {
    it(`${entry.caseId}: preserves every captured candidate and its displayed identity`, async () => {
      const query = queries.cases.find((c: { id: string }) => c.id === entry.caseId);
      const features = entry.rawIds.map((id: string) => {
        const feature = responses.features.find((f: { raw: { id: string } }) => f.raw.id === id);
        if (!feature) throw new Error("Missing regression candidate");
        return feature;
      });
      const fetch = vi
        .fn()
        .mockResolvedValue(
          Response.json({ features: features.map((f: { raw: unknown }) => f.raw) }),
        );
      vi.stubGlobal("fetch", fetch);
      setMaptilerApiKey("fixture-only");
      const adapted = await maptilerGeocodingService.autocomplete(query.query, queries.language, {
        proximity: queries.upstreamProximity,
        zoom: queries.zoom,
      });
      const fields = (r: {
        id: string;
        label: string;
        sublabel?: string;
        coordinates?: readonly number[];
        type: string;
        rawCategory?: string;
        ids?: unknown;
      }) => [r.id, r.label, r.sublabel, r.coordinates, r.type, r.rawCategory, r.ids];
      expect(adapted.map(fields)).toEqual(
        features.map((f: { adapted: Parameters<typeof fields>[0] }) => fields(f.adapted)),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it("keeps ordinary business names outside the specialized code/alias index", () => {
    for (const id of ["way/1204762785", "node/322490364", "node/348000444", "node/9154787137"]) {
      const record = sources.osm.records.find((r: { id: string }) => r.id === id);
      expect(extractTerms(record.tags)).toEqual([]);
    }
  });
});
