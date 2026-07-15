import { describe, expect, it } from "vitest";
import { compileGbfsCatalog, parseMobilityDataGbfsCsv } from "../src/gbfs-catalog.js";

const CSV = `Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL
DE,Beta Bikes,Berlin,beta,https://beta.example,https://beta.example/gbfs.json,2.3,
AT,Alpha Bikes,Vienna,alpha,https://alpha.example,https://alpha.example/gbfs.json,3.0,
CH,Existing,Zurich,existing,https://existing.example,https://existing.example/gbfs.json,2.3,
US,Outside,Austin,outside,https://outside.example,https://outside.example/gbfs.json,2.3,
DE,Authenticated,Berlin,auth,https://auth.example,https://auth.example/gbfs.json,2.3,https://auth.example/access
`;

describe("pinned MobilityData GBFS compiler", () => {
  it("is deterministic, country-scoped, and prefers existing Transitous feeds", () => {
    const input = {
      rows: parseMobilityDataGbfsCsv(CSV),
      countries: ["ch", "de", "at"],
      existingSources: [
        {
          region: "ch",
          name: "curated",
          discoveryUrl: "https://existing.example/gbfs.json",
          provenance: "transitous" as const,
        },
      ],
      quarantine: [],
      maxAdditions: 10,
    };
    const first = compileGbfsCatalog(input);
    const second = compileGbfsCatalog({ ...input, rows: [...input.rows].reverse() });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.additions.map((entry) => entry.region)).toEqual(["at", "de"]);
    expect(first.summary).toMatchObject({ included: 2, duplicate: 1, invalid: 1, outOfScope: 1 });
  });

  it("honors quarantine and a hard maximum", () => {
    const rows = parseMobilityDataGbfsCsv(CSV);
    const initial = compileGbfsCatalog({
      rows,
      countries: ["de", "at"],
      existingSources: [],
      quarantine: [],
      maxAdditions: 10,
    });
    const blockedId = initial.additions[0]?.sourceId;
    expect(blockedId).toBeTruthy();
    const compiled = compileGbfsCatalog({
      rows,
      countries: ["de", "at"],
      existingSources: [],
      quarantine: [{ sourceId: blockedId ?? "", reason: "bad", firstSeen: "x", lastChecked: "y" }],
      maxAdditions: 1,
    });
    expect(compiled.summary).toMatchObject({ included: 1, quarantined: 1 });
  });
});
