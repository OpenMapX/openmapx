import { describe, expect, it } from "vitest";
import {
  assertValidFeedSlug,
  InvalidFeedSlugError,
  isValidFeedSlug,
  normalizeFeedSlug,
} from "../utils/feed-slug";

describe("feed-slug", () => {
  describe("isValidFeedSlug", () => {
    it("accepts canonical slugs", () => {
      expect(isValidFeedSlug("abc")).toBe(true);
      expect(isValidFeedSlug("gtfs_de_vbb")).toBe(true);
      expect(isValidFeedSlug("us-mbta")).toBe(true);
      expect(isValidFeedSlug("0abc")).toBe(true);
      expect(isValidFeedSlug("a".repeat(63))).toBe(true);
    });

    it("rejects injection payloads", () => {
      expect(isValidFeedSlug('x"; DROP SCHEMA public CASCADE; --')).toBe(false);
      expect(isValidFeedSlug('foo"bar')).toBe(false);
      expect(isValidFeedSlug("foo'bar")).toBe(false);
      expect(isValidFeedSlug("foo;bar")).toBe(false);
    });

    it("rejects path-traversal payloads", () => {
      expect(isValidFeedSlug("../etc")).toBe(false);
      expect(isValidFeedSlug("a/b")).toBe(false);
      expect(isValidFeedSlug("a\\b")).toBe(false);
      expect(isValidFeedSlug("a b")).toBe(false);
    });

    it("rejects shape issues", () => {
      expect(isValidFeedSlug("")).toBe(false);
      expect(isValidFeedSlug("_leading")).toBe(false);
      expect(isValidFeedSlug("-leading")).toBe(false);
      expect(isValidFeedSlug("Upper")).toBe(false);
      expect(isValidFeedSlug("a".repeat(64))).toBe(false);
    });

    it("rejects non-strings", () => {
      expect(isValidFeedSlug(123 as unknown)).toBe(false);
      expect(isValidFeedSlug(null)).toBe(false);
      expect(isValidFeedSlug(undefined)).toBe(false);
      expect(isValidFeedSlug({} as unknown)).toBe(false);
    });
  });

  describe("assertValidFeedSlug", () => {
    it("throws InvalidFeedSlugError for invalid slugs", () => {
      expect(() => assertValidFeedSlug('x"; DROP SCHEMA')).toThrow(InvalidFeedSlugError);
      expect(() => assertValidFeedSlug("../etc")).toThrow(InvalidFeedSlugError);
    });

    it("passes for valid slugs", () => {
      expect(() => assertValidFeedSlug("de_vbb")).not.toThrow();
    });
  });

  describe("normalizeFeedSlug", () => {
    it("normalizes human-friendly names", () => {
      expect(normalizeFeedSlug("VBB Berlin")).toBe("vbb_berlin");
      expect(normalizeFeedSlug("de/vbb")).toBe("de_vbb");
      expect(normalizeFeedSlug("US - MBTA!")).toBe("us_-_mbta");
    });

    it("returns null for unrecoverable input", () => {
      expect(normalizeFeedSlug("")).toBe(null);
      expect(normalizeFeedSlug("!!!")).toBe(null);
      expect(normalizeFeedSlug("___")).toBe(null);
    });

    it("truncates to 63 chars", () => {
      const long = "a".repeat(200);
      const out = normalizeFeedSlug(long);
      expect(out).not.toBeNull();
      expect(out?.length).toBeLessThanOrEqual(63);
    });
  });
});
