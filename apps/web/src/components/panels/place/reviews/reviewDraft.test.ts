import { describe, expect, it } from "vitest";
import { saveReviewDraft, takeReviewDraft } from "./reviewDraft";

describe("temporary review draft during reconnect", () => {
  it("keeps content once for the exact owner/subject and never carries publishing consent", () => {
    const data = new Map<string, string>();
    const store = {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => {
        data.set(k, v);
      },
      removeItem: (k: string) => {
        data.delete(k);
      },
    };
    saveReviewDraft(
      store,
      "owner/place",
      {
        stars: 0,
        opinion: "Draft",
        images: [],
        experience: null,
        isAffiliated: false,
        license: "CC-BY-4.0",
      },
      1000,
    );
    expect(takeReviewDraft(store, "other/place", 1000)).toBeNull();
    expect(takeReviewDraft(store, "owner/place", 1001)?.opinion).toBe("Draft");
    expect(takeReviewDraft(store, "owner/place", 1001)).toBeNull();
  });
});
