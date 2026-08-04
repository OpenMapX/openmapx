import { describe, expect, it } from "vitest";
import { normaliseCountries } from "../../src/jobs/transitous/internal.js";

describe("normaliseCountries", () => {
  it("drops non-string and unsafe tokens while lowercasing and deduplicating slugs", () => {
    const input = [
      "DE",
      "de",
      "North-America",
      "north-america",
      "-x",
      "foo/bar",
      42,
      null,
      "",
    ] as unknown as string[];

    expect(normaliseCountries(input)).toEqual(["de", "north-america"]);
  });
});
