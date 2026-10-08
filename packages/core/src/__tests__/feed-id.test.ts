import { describe, expect, it } from "vitest";
import { feedIdSchema } from "../feed-id";

describe("feedIdSchema", () => {
  it("accepts region-first slugs", () => {
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
