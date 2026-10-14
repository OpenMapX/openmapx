import { describe, expect, it } from "vitest";
import { dedupeAttributionHtml, projectAttributionPresentations } from "./attribution-presentation";

describe("complete credited publisher fragments", () => {
  it.each([
    ["© City A", "© City AB"],
    ["© City A", "© City A County"],
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
});
