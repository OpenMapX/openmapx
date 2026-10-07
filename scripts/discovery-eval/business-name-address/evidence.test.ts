import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getQueryVariants } from "../../../integrations/geocoding/query-expansion.js";
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
const historical = read("replay-v1.json");
const ui = read("ui-v1.json");

afterEach(() => {
  setMaptilerApiKey(undefined);
  vi.unstubAllGlobals();
});

describe("#430 versioned business retrieval evidence", () => {
  it("pins a complete query set and keeps replay and deployment conditions distinct", () => {
    expect(responses.queriesSha256).toBe(
      createHash("sha256")
        .update(readFileSync(new URL("queries-v1.json", import.meta.url)))
        .digest("hex"),
    );
    expect(historical.baseline).toBe(queries.baseline);
    const ids = queries.cases.map((c: { id: string }) => c.id);
    expect(new Set(ids).size).toBe(13);
    expect(responses.cases.map((c: { caseId: string }) => c.caseId)).toEqual(ids);
    expect(historical.cases.map((c: { caseId: string }) => c.caseId)).toEqual(ids);
    expect(ui.caseResults.map((c: { caseId: string }) => c.caseId)).toEqual(ids);
    expect(ui.deployment).toBeNull();
    expect(ui.cache).toBe("uncontrolled");
  });

  for (const entry of responses.cases) {
    it(`${entry.caseId}: maps every raw candidate without inventing tenant retrieval`, async () => {
      const query = queries.cases.find((c: { id: string }) => c.id === entry.caseId);
      expect(getQueryVariants(query.query)).toEqual([query.query]);
      const fetch = vi.fn().mockResolvedValue(Response.json({ features: entry.rawFeatures }));
      vi.stubGlobal("fetch", fetch);
      setMaptilerApiKey("fixture-only");
      const adapted = await maptilerGeocodingService.autocomplete(query.query, queries.language, {
        proximity: queries.upstreamProximity,
        zoom: queries.zoom,
      });
      expect(adapted.map((r) => r.id)).toEqual(entry.publicRows.map((r: { id: string }) => r.id));
      expect(adapted.map((r) => [r.label, r.sublabel, r.coordinates, r.type])).toEqual(
        entry.publicRows.map(
          (r: { label: string; sublabel: string; coordinates: number[]; type: string }) => [
            r.label,
            r.sublabel,
            r.coordinates,
            r.type,
          ],
        ),
      );
      expect(fetch).toHaveBeenCalledTimes(1);
      expect(entry.aggregate).toEqual({ suggestions: [], attributions: [], partial: true });
      for (const capture of entry.captures) {
        expect(capture.status).toBe(200);
        expect(capture.requests).toBe(1);
        expect(capture.cache).toBe("uncontrolled");
        expect(capture.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(Number.isFinite(capture.latencyMs) && capture.latencyMs > 0).toBe(true);
        expect(capture.parameters).not.toHaveProperty("key");
      }
      const replay = historical.cases.find((c: { caseId: string }) => c.caseId === entry.caseId);
      expect(replay.combinedIds).toEqual(entry.publicRows.map((r: { id: string }) => r.id));
      // Validate a historical trace without requiring future rankers to preserve #428/#429 bugs.
      expect(replay.rankedIds.every((id: string) => replay.combinedIds.includes(id))).toBe(true);
      expect(new Set(replay.rankedIds).size).toBe(replay.rankedIds.length);
    });
  }

  it("keeps the unresolved mall way separate from the verified Overture Moch record", () => {
    const way = sources.osm.records.find((r: { id: string }) => r.id === "way/1204762785");
    expect(way.version).toBe(3);
    expect(way.tags.name).toBe("EDEKA");
    expect(way.tags["addr:street"]).toBeUndefined();
    expect(extractTerms(way.tags)).toEqual([]);
    const raw = responses.cases.find((c: { caseId: string }) => c.caseId === "edeka-alexa");
    expect(raw.rawFeatures[0].properties.ref).toBe("osm:w1204762785");
    expect(raw.rawFeatures[0].place_name).toContain("Alexanderstraße 25");
    const moch = sources.overture.records.find(
      (r: { id: string }) => r.id === "035b544e-40f5-4ce0-a06f-1c9032ded028",
    );
    expect(sources.overture.release).toBe("2026-09-23.1");
    expect(moch.version).toBe(13);
    expect(moch.addresses[0].freeform).toBe("Grunerstraße 20");
    expect(moch.phones).toContain("+493024045625");
    expect(moch.sources[0].record_id).toBe("194804870560113");
    expect(moch.sources[0].license).toBe("CDLA-Permissive-2.0");
    expect(moch.operating_status).not.toBe("permanently_closed");
    expect(queries.cases.find((c: { id: string }) => c.id === "edeka-alexander").target).toBeNull();
  });

  it("recomputes the report's historical recall and row counts using verified OSM identities", () => {
    // A provider ID/label or shared mall address alone is not branch verification.
    // These controls have independently checked retailer listings and OSM references.
    const verifiedRefs: Record<string, string> = {
      media: "osm:n322490364",
      rewe: "osm:n348000444",
      schaaf: "osm:n9154787137",
    };
    const positive = queries.cases.filter(
      (c: { target: string | null }) => c.target && c.target !== "negative",
    );
    expect(positive).toHaveLength(9);
    const hits = [0, 0, 0, 0];
    for (const query of positive) {
      const capture = responses.cases.find((c: { caseId: string }) => c.caseId === query.id);
      const trace = historical.cases.find((c: { caseId: string }) => c.caseId === query.id);
      const verifiedIds = capture.rawFeatures
        .filter(
          (f: { properties: { ref?: string } }) =>
            verifiedRefs[query.target] !== undefined &&
            f.properties.ref === verifiedRefs[query.target],
        )
        .map((f: { id: string }) => `maptiler:${f.id}`);
      const stages = [
        capture.rawFeatures.map((f: { id: string }) => `maptiler:${f.id}`),
        capture.publicRows.map((r: { id: string }) => r.id),
        trace.combinedIds,
        trace.rankedIds,
      ];
      stages.forEach((ids: string[], stage: number) => {
        if (ids.slice(0, queries.budgets.maxRank).some((id) => verifiedIds.includes(id))) {
          hits[stage]++;
        }
      });
    }
    expect(hits).toEqual([4, 4, 4, 4]);
    expect(
      historical.cases.reduce(
        (n: number, c: { combinedIds: string[] }) => n + c.combinedIds.length,
        0,
      ),
    ).toBe(78);
    expect(
      historical.cases.reduce((n: number, c: { rankedIds: string[] }) => n + c.rankedIds.length, 0),
    ).toBe(65);
  });

  it("retains real branch and co-located tenant controls and negative query judgments", () => {
    const names = sources.overture.records.map(
      (r: { names: { primary: string } }) => r.names.primary,
    );
    expect(names).toContain("EDEKA Schaaf");
    expect(names).toContain("MediaMarkt Berlin-Mitte (im Alexa)");
    const media = sources.osm.records.find((r: { id: string }) => r.id === "node/322490364");
    expect(media.tags["addr:street"]).toBe("Grunerstraße");
    expect(media.tags["addr:housenumber"]).toBe("20");
    expect(extractTerms(media.tags)).toEqual([]);
    expect(queries.cases.filter((c: { target: string }) => c.target === "negative")).toHaveLength(
      2,
    );
    const nameQuery = responses.cases.find((c: { caseId: string }) => c.caseId === "moch-name");
    expect(nameQuery.rawFeatures.some((f: { text: string }) => /\bmoch\b/i.test(f.text))).toBe(
      false,
    );
    const addressQuery = responses.cases.find(
      (c: { caseId: string }) => c.caseId === "moch-address",
    );
    expect(
      addressQuery.rawFeatures.some((f: { place_type: string[] }) => f.place_type.includes("poi")),
    ).toBe(false);
    expect(ui.selections[0].selectedId).toBeNull();
    expect(ui.selections[1].selectedId).toBe("maptiler:poi.39267497");
  });
});
