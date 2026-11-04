import { licensingReferenceUrls, parseLicensing } from "@openmapx/mobility-core/licensing";
import { describe, expect, it, vi } from "vitest";
import * as attributionHtml from "./attribution";
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

it("parses each distinct HTML input once when grouping 100 independent visible notices", () => {
  const parse = vi.spyOn(attributionHtml, "parseAttributionHtml");
  try {
    const entries = Array.from({ length: 100 }, (_, i) => ({
      fullHtml: `<a href="https://publisher.example/${i}">Publisher ${i}</a>`,
      visibleHtml: `<a href="https://publisher.example/${i}">Publisher ${i}</a>`,
      logos: [],
    }));
    const result = projectAttributionPresentations(entries);
    expect(result.visible).toHaveLength(100);
    expect(result.fullHtml).toHaveLength(100);
    expect(parse).toHaveBeenCalledTimes(100);
  } finally {
    parse.mockRestore();
  }
});

it("retains combined links through successive visible-notice merges", () => {
  const result = projectAttributionPresentations(
    [
      "© A",
      '<a href="https://a.example/">© A</a> (ODbL-1.0)',
      "© A (ODbL-1.0) | © B",
      '<a href="https://b.example/">© B</a>',
    ].map((html) => ({ fullHtml: html, visibleHtml: html, logos: [] })),
  );
  expect(result.visible).toHaveLength(1);
  expect(attributionHtml.parseAttributionHtml(result.visible[0].html)).toEqual({
    text: "© A (ODbL-1.0) | © B",
    links: [
      { label: "© A", url: "https://a.example/" },
      { label: "© B", url: "https://b.example/" },
    ],
  });
});

it("preserves HTML parser normalization between successive notice merges", () => {
  const entries = [
    "© A | © B",
    '<a href="https://a.example/?x=&#13;">© A</a>',
    '<a href="https://a.example/?x=&#13;">© A</a>',
    '<a href="https://b.example/">© B</a>',
  ].map((html) => ({ fullHtml: html, visibleHtml: html, logos: [] }));
  // Re-parsing the first merged fragment normalizes the raw carriage return
  // in its href to a line feed. The later original link is distinct.
  const result = projectAttributionPresentations(entries);
  expect(result.visible).toHaveLength(2);
  expect(attributionHtml.parseAttributionHtml(result.visible[0].html).links).toEqual([
    { label: "© A", url: "https://a.example/?x=\n" },
    { label: "© B", url: "https://b.example/" },
  ]);
});

const repeatedLabelNotice =
  '© <a href="https://www.maptiler.com/copyright/">MapTiler</a> (MapTiler material: Licence not specified; MapTiler access/account contract: <a href="https://www.maptiler.com/terms/cloud/">Licence not specified</a>)';

it("collapses identical notices with repeated link labels without reconstructing their HTML", () => {
  const entries = Array.from({ length: 10 }, () => ({
    fullHtml: repeatedLabelNotice,
    visibleHtml: repeatedLabelNotice,
    logos: [],
  }));
  const result = projectAttributionPresentations(entries);
  expect(result.visible).toEqual([{ html: repeatedLabelNotice, logos: [] }]);
  expect(result.fullHtml).toEqual([repeatedLabelNotice]);
});

it("keeps full notices and stricter branding when identical visible notices collapse", () => {
  const result = projectAttributionPresentations([
    {
      fullHtml: "Dataset A required notice",
      visibleHtml: repeatedLabelNotice,
      logos: ["maptiler"],
    },
    {
      fullHtml: "Dataset B required notice",
      visibleHtml: repeatedLabelNotice,
      logos: ["tdx", "maptiler"],
      prominence: "normal",
    },
  ]);
  expect(result.visible).toEqual([
    { html: repeatedLabelNotice, logos: ["maptiler", "tdx"], prominence: "normal" },
  ]);
  expect(result.fullHtml).toEqual(["Dataset A required notice", "Dataset B required notice"]);
  expect(result.details).toEqual([
    { html: "Dataset A required notice", attribution: undefined },
    { html: "Dataset B required notice", attribution: undefined },
  ]);
});

it("retains ambiguous repeated-label notices when their link targets differ", () => {
  const other = repeatedLabelNotice.replace(
    "https://www.maptiler.com/terms/cloud/",
    "https://publisher.example/other-terms",
  );
  const result = projectAttributionPresentations(
    [repeatedLabelNotice, other].map((html) => ({ fullHtml: html, visibleHtml: html, logos: [] })),
  );
  expect(result.visible).toHaveLength(2);
  expect(result.fullHtml).toEqual([repeatedLabelNotice, other]);
});

describe("credits without an unstated licence", () => {
  const credit = (license: Record<string, unknown>) =>
    attributionHtml.buildRuntimeAttributionHtml({
      sourceId: "kvb",
      name: "Kölner Verkehrs-Betriebe AG",
      url: "https://kvb.koeln/",
      licensing: {
        version: 1,
        bindings: [{ scope: "data", subject: "KVB", license }],
      } as never,
    });

  it("names the source alone when its licence is unknown", () => {
    expect(credit({ kind: "unknown" })).toBe(
      '<a href="https://kvb.koeln/" target="_blank" rel="noopener noreferrer">Kölner Verkehrs-Betriebe AG</a>',
    );
  });

  it("treats a catalogue's placeholder as no licence", () => {
    expect(credit({ kind: "unknown", raw: "todo" })).not.toContain("todo");
  });

  it("keeps a licence the source names", () => {
    expect(credit({ kind: "spdx", expression: "CC-BY-4.0" })).toContain("CC-BY-4.0");
    expect(credit({ kind: "unknown", raw: "Proprietary" })).toContain("Proprietary");
  });
});
