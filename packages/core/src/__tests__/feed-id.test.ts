import { describe, expect, it } from "vitest";
import { assertUniqueFeedIds, deriveFeedId, feedIdSchema } from "../feed-id";

describe("deriveFeedId", () => {
  it("joins present parts with hyphens, dropping empties", () => {
    expect(deriveFeedId({ country: "ch", operator: "sfoe" })).toBe("ch-sfoe");
    expect(deriveFeedId({ country: "de", subdivision: "by", operator: "bamberg" })).toBe(
      "de-by-bamberg",
    );
    expect(
      deriveFeedId({ country: "de", subdivision: "nw", operator: "mobidrom", stream: "pr" }),
    ).toBe("de-nw-mobidrom-pr");
    expect(deriveFeedId({ operator: "ocm" })).toBe("ocm"); // global provider, no country
  });
});

describe("feedIdSchema", () => {
  it("accepts table/redis-safe slugs", () => {
    for (const id of ["ch-sfoe", "de-by-bamberg", "nl-dotnl", "ocm", "us-afdc"]) {
      expect(feedIdSchema.safeParse(id).success).toBe(true);
    }
  });
  it("rejects uppercase, spaces, leading/trailing/double hyphen", () => {
    for (const id of ["CH-sfoe", "ch sfoe", "-ch", "ch-", "ch--sfoe"]) {
      expect(feedIdSchema.safeParse(id).success).toBe(false);
    }
  });
});

describe("assertUniqueFeedIds", () => {
  it("throws on a duplicate id (cross-domain collision)", () => {
    expect(() => assertUniqueFeedIds(["a", "b", "a"])).toThrow(/duplicate feed id/i);
  });
  it("passes when all unique", () => {
    expect(() => assertUniqueFeedIds(["a", "b", "c"])).not.toThrow();
  });
});
