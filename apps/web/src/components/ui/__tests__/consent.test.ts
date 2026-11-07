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
    expect(isNlpCloudDeclined()).toBe(false);
  });

  it("returns true after setNlpConsent(true)", () => {
    setNlpConsent(true);
    expect(hasNlpConsent()).toBe(true);
    expect(getNlpConsent()).toBe(true);
    expect(isNlpCloudDeclined()).toBe(false);
  });

  it("returns false after setNlpConsent(false)", () => {
    setNlpConsent(true);
    setNlpConsent(false);
    expect(hasNlpConsent()).toBe(false);
    expect(getNlpConsent()).toBe(false);
    expect(isNlpCloudDeclined()).toBe(true);
  });
});
