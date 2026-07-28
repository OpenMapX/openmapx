// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from "vitest";
import { getNlpConsent, hasNlpConsent, isNlpCloudDeclined, setNlpConsent } from "../nlpConsent";

describe("NLP cloud consent helper", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("defaults to false when no key is stored", () => {
    expect(hasNlpConsent()).toBe(false);
    expect(getNlpConsent()).toBeNull();
  });

  it("returns true after setNlpConsent(true)", () => {
    setNlpConsent(true);
    expect(hasNlpConsent()).toBe(true);
    expect(getNlpConsent()).toBe(true);
  });

  it("returns false after setNlpConsent(false)", () => {
    setNlpConsent(true);
    setNlpConsent(false);
    expect(hasNlpConsent()).toBe(false);
    expect(getNlpConsent()).toBe(false);
  });

  describe("isNlpCloudDeclined", () => {
    it("is false when no key is stored", () => {
      expect(isNlpCloudDeclined()).toBe(false);
    });

    it("is true and hasNlpConsent is false after setNlpConsent(false)", () => {
      setNlpConsent(false);
      expect(isNlpCloudDeclined()).toBe(true);
      expect(hasNlpConsent()).toBe(false);
    });

    it("is false and hasNlpConsent is true after setNlpConsent(true)", () => {
      setNlpConsent(true);
      expect(isNlpCloudDeclined()).toBe(false);
      expect(hasNlpConsent()).toBe(true);
    });
  });
});
