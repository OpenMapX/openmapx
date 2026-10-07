import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CATALOG, INPUT_FILES } from "./catalog.js";

describe("discovery input inventory", () => {
  it("runs selected-place partial states as well as list-card enrichment", () => {
    expect(
      CATALOG.some(
        (entry) =>
          entry.suite === "apps/web/src/components/panels/place/PlaceDetailContent.test.tsx",
      ),
    ).toBe(true);
  });
  it("fingerprints the recorded upstream station results used by cold/warm ranking", () => {
    const entry = CATALOG.find((entry) => entry.id === "search/station-synonyms-cache-order");
    expect(entry?.fixtures).toContain(
      "integrations/geocoding-maptiler/__fixtures__/station-search.json",
    );
    expect(INPUT_FILES).toContain(
      "integrations/geocoding-maptiler/__fixtures__/station-search.json",
    );
  });

  it("includes external JSON imports from every selected suite", () => {
    for (const entry of CATALOG.filter((entry) => entry.suite)) {
      const suite = entry.suite!;
      const source = readFileSync(suite, "utf8");
      for (const match of source.matchAll(/from\s+["'](\.[^"']+\.json)["']/g)) {
        const path = resolve(suite, "..", match[1]).slice(`${process.cwd()}/`.length);
        expect(INPUT_FILES, `${suite} reads ${path}`).toContain(path);
      }
    }
  });
});
