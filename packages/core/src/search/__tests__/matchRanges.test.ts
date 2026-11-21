import { describe, expect, it } from "vitest";
import { matchRanges } from "../matchRanges";

describe("matchRanges", () => {
  it("marks the typed start of the label", () => {
    expect(matchRanges("Coffee Circle", "coff")).toEqual([[0, 4]]);
  });

  it("ignores case and accents and maps back to the original text", () => {
    expect(matchRanges("Café Einstein", "cafe")).toEqual([[0, 4]]);
    expect(matchRanges("Kurfürstendamm 21", "KURFURST")).toEqual([[0, 8]]);
  });

  it("marks each typed word at the start of a label word, in any order", () => {
    expect(matchRanges("Berlin Hauptbahnhof", "haupt berl")).toEqual([
      [0, 4],
      [7, 12],
    ]);
  });

  it("does not mark text in the middle of a word", () => {
    expect(matchRanges("Palmers Brewery", "rewe")).toEqual([]);
  });

  it("merges overlapping marks and skips an empty query", () => {
    expect(matchRanges("Alexanderplatz", "alex alexander")).toEqual([[0, 9]]);
    expect(matchRanges("Alexanderplatz", "  ")).toEqual([]);
  });

  it("matches across an apostrophe inside a word", () => {
    expect(matchRanges("King's Cross", "kings")).toEqual([[0, 6]]);
  });

  it("keeps offsets right after characters outside the basic plane", () => {
    expect(matchRanges("🍕 Pizza Max", "max")).toEqual([[9, 12]]);
  });
});
