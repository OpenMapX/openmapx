import { describe, expect, it } from "vitest";
import { refKind, signHeadline, visibleToward } from "../signFormat";

describe("refKind", () => {
  it.each([
    ["A 57", "motorway"],
    ["A57", "motorway"],
    ["E 35", "european"],
    ["B 9", "federal"],
    ["M25", "motorway"],
    ["I-95", "motorway"],
    ["L 380", "other"],
    ["Neuss-Zentrum", "other"],
  ])("classifies %s as %s", (ref, kind) => {
    expect(refKind(ref)).toBe(kind);
  });
});

describe("visibleToward", () => {
  it("caps the list at three entries", () => {
    expect(visibleToward(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
  });

  it("keeps lists of three or fewer intact", () => {
    expect(visibleToward(["a", "b"])).toEqual(["a", "b"]);
    expect(visibleToward([])).toEqual([]);
  });
});

describe("signHeadline", () => {
  it("prefers exitToward over exitNames", () => {
    expect(
      signHeadline({ exitNames: ["Kreuz Neuss-West"], exitToward: ["Neuss-Zentrum"] }),
    ).toEqual(["Neuss-Zentrum"]);
  });

  it("falls back to exitNames", () => {
    expect(signHeadline({ exitNames: ["Aéroport"] })).toEqual(["Aéroport"]);
  });

  it("returns an empty list without exit content", () => {
    expect(signHeadline({ exitNumbers: ["20"] })).toEqual([]);
    expect(signHeadline({})).toEqual([]);
  });
});
