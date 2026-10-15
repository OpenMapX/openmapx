import { licensingReferenceUrls, parseLicensing } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import {
  dedupeAttributionHtml,
  mergeAttributionDetails,
  projectAttributionPresentations,
} from "./attribution-presentation";

describe("complete credited publisher fragments", () => {
  it.each([
    ["© City A", "© City AB"],
    ["© City A", "© City A County"],
    ["© City A", "© City A—West"],
    ["© City A", "© City A —West"],
  ])("does not hide %s as a prefix of %s", (first, second) => {
    const group = projectAttributionPresentations(
      [first, second].map((html) => ({ fullHtml: html, visibleHtml: html, logos: [] })),
    );
    expect(group.fullHtml).toHaveLength(2);
    expect(group.visible).toHaveLength(2);
  });
  it("still recognizes complete separate credits and licence-suffixed wording", () => {
    expect(dedupeAttributionHtml(["© A", "© A | © B"])).toEqual(["© A | © B"]);
    expect(
      projectAttributionPresentations(
        ["© A", "© A (ODbL-1.0)"].map((html) => ({ fullHtml: html, visibleHtml: html, logos: [] })),
      ).visible,
    ).toHaveLength(1);
  });
  it("keeps one complete receipt when the richer copy appends a publisher, retaining every distinct link", () => {
    const credit = '<a href="https://photo.example/file">Photo archive</a> (CC-BY-4.0)';
    const full = `${credit} — <a href="https://creator.example">Creator</a>`;
    expect(dedupeAttributionHtml([credit, full])).toEqual([full]);
    const other = '<a href="https://other.example/file">Photo archive</a> (CC-BY-4.0)';
    expect(dedupeAttributionHtml([other, full])).toEqual([other, full]);
  });
});

it("groups the same displayed source without losing distinct grants, notices or link targets", async () => {
  const { buildAttributionPresentation } = await import("./attribution");
  const group = projectAttributionPresentations([
    buildAttributionPresentation(
      {
        sourceId: "one",
        name: "Same source",
        url: "https://source.example/",
        licensing: {
          version: 1,
          bindings: [
            { scope: "data", subject: "Data", license: { kind: "spdx", expression: "CC-BY-4.0" } },
          ],
        },
      },
      "content",
    ),
    buildAttributionPresentation(
      {
        sourceId: "two",
        name: "Same source",
        url: "https://source.example/",
        licensing: {
          version: 1,
          bindings: [
            {
              scope: "software",
              subject: "Software",
              license: { kind: "spdx", expression: "MIT" },
            },
          ],
        },
      },
      "content",
    ),
    buildAttributionPresentation(
      {
        sourceId: "three",
        name: "Same source",
        url: "https://other.example/",
        attributionText: "Distinct notice",
      },
      "content",
    ),
  ]);
  expect(group.details).toHaveLength(2);
  expect(group.details[0]?.attribution?.licensing?.bindings).toHaveLength(2);
  expect(group.details[1]?.attribution?.url).toBe("https://other.example/");
  expect(group.details[1]?.attribution?.attributionText).toBe("Distinct notice");
});

it("retains every independent declaration URL when grouping credit-only source snapshots", () => {
  const entry = (url: string) => ({
    html: "Provider",
    attribution: {
      sourceId: "provider",
      name: "Provider",
      licensing: {
        version: 1 as const,
        bindings: [],
        declarations: [{ text: "Original terms", url }],
      },
    },
  });
  const [merged] = mergeAttributionDetails([
    entry("https://old.example/terms"),
    entry("https://new.example/terms"),
  ]);
  expect(merged.attribution?.licensing?.declarations).toEqual([
    { text: "Original terms", url: "https://old.example/terms" },
    { text: "Original terms", url: "https://new.example/terms" },
  ]);
});

it.each(["bindings", "declarations"] as const)(
  "keeps large captured %s unions renderable without losing individual snapshots",
  (field) => {
    const entries = Array.from({ length: 65 }, (_, index) => ({
      html: "Provider",
      attribution: {
        sourceId: "provider",
        name: "Provider",
        licensing: {
          version: 1 as const,
          bindings:
            field === "bindings"
              ? [
                  {
                    scope: "data" as const,
                    subject: `Dataset ${index}`,
                    license: { kind: "spdx" as const, expression: "CC-BY-4.0" },
                  },
                ]
              : [],
          declarations: [
            {
              text: "Original terms",
              url: `https://provider.example/terms/${field === "bindings" ? "shared" : index}`,
            },
          ],
        },
      },
    }));
    const groups = mergeAttributionDetails(entries);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.every((group) => parseLicensing(group.attribution?.licensing))).toBe(true);
    expect(
      new Set(
        groups.flatMap((group) =>
          group.attribution?.licensing ? licensingReferenceUrls(group.attribution.licensing) : [],
        ),
      ).size,
    ).toBe(field === "bindings" ? 1 : 65);
    expect(groups.flatMap((group) => group.attribution?.licensing?.bindings ?? [])).toHaveLength(
      field === "bindings" ? 65 : 0,
    );
  },
);

it("deduplicates unstructured notices while preserving their links", () => {
  const entry = {
    html: "Captured provider notice",
    links: [{ label: "Provider", url: "https://provider.example/" }],
  };
  expect(mergeAttributionDetails([entry, structuredClone(entry)])).toEqual([entry]);
});
