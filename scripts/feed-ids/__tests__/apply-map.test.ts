import { describe, expect, it } from "vitest";
import { collectTargetFiles, rewriteText } from "../apply-map.ts";

// Safety-focused cases for the quoted-literal-equality rewrite rule. `oldId`s
// overlap as substrings (e.g. "apag" inside "apag-mobidrom") and appear inside
// import paths / identifiers, so a naive boundary/substring replace would
// corrupt those. These cases prove the rewrite only ever touches a fully
// quoted string literal (or an unquoted object key) equal to the whole oldId.

const A = { oldId: "apag", newId: "de-apag", oldPrefix: "apag:", newPrefix: "de-apag:" };
const B = {
  oldId: "apag-mobidrom",
  newId: "de-apag-mobidrom",
  oldPrefix: "apag-mobidrom:",
  newPrefix: "de-apag-mobidrom:",
};
const S = {
  oldId: "switzerland-ev",
  newId: "ch-sfoe",
  oldPrefix: "swiss-sfoe:",
  newPrefix: "ch-sfoe:",
};

describe("rewriteText", () => {
  it("replaces a quoted id + prefix token pair", () => {
    const src = `source("switzerland-ev", s, "swiss-sfoe:", d);`;
    expect(rewriteText(src, [S])).toBe(`source("ch-sfoe", s, "ch-sfoe:", d);`);
  });

  it("does not let a shorter oldId corrupt a longer oldId that contains it as a substring", () => {
    const src = `["apag", "apag-mobidrom", "apag:", "apag-mobidrom:"]`;
    const out = rewriteText(src, [A, B]);
    expect(out).toBe(`["de-apag", "de-apag-mobidrom", "de-apag:", "de-apag-mobidrom:"]`);
    // Explicitly confirm the longer id was never touched by the shorter id's rule.
    expect(out).toContain("de-apag-mobidrom");
    expect(out).not.toContain("de-apagde-apag-mobidrom");
  });

  it("leaves import specifiers and identifiers untouched", () => {
    const src = `import { searchApag } from "./apag.js";`;
    expect(rewriteText(src, [A])).toBe(src);
  });

  it("rewrites a bare (unquoted) object key to a quoted newId", () => {
    const src = `{ apag: 1, "apag-mobidrom": 2 }`;
    expect(rewriteText(src, [A, B])).toBe(`{ "de-apag": 1, "de-apag-mobidrom": 2 }`);
  });

  it("does not rewrite a quoted oldId that only appears inside comment prose", () => {
    const src = [
      '// Source id is unchanged ("apag", "apag:" prefix), see apag-parser.ts.',
      'const sourceId = "apag";',
    ].join("\n");
    expect(rewriteText(src, [A])).toBe(
      [
        '// Source id is unchanged ("apag", "apag:" prefix), see apag-parser.ts.',
        'const sourceId = "de-apag";',
      ].join("\n"),
    );
  });

  it("is idempotent — a second pass over already-rewritten text is a no-op", () => {
    const once = rewriteText(`"switzerland-ev"`, [S]);
    expect(rewriteText(once, [S])).toBe(once);
  });
});

describe("collectTargetFiles", () => {
  it("includes fuel provider files, not just ev-charging/parking", () => {
    const files = collectTargetFiles();
    expect(files.some((file) => /\/integrations\/fuel\/providers\//.test(file))).toBe(true);
  });
});
