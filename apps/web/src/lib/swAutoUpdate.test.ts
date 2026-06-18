import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_RELOAD_COOLDOWN_MS,
  type AutoUpdateSafetyInputs,
  hasUnsavedTextEntry,
  isSafeToAutoReload,
} from "./swAutoUpdate";

const ALL_CLEAR: AutoUpdateSafetyInputs = {
  online: true,
  navStatus: "idle",
  mutationCount: 0,
  hasActiveDownload: false,
  hasUnsavedText: false,
  msSinceLastAutoReload: Number.POSITIVE_INFINITY,
};

describe("isSafeToAutoReload", () => {
  it("returns true when all conditions are clear", () => {
    expect(isSafeToAutoReload(ALL_CLEAR)).toBe(true);
  });

  it("returns false when offline", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, online: false })).toBe(false);
  });

  it("returns false when navigating", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, navStatus: "navigating" })).toBe(false);
  });

  it("returns false when rerouting", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, navStatus: "rerouting" })).toBe(false);
  });

  it("returns false when there is an in-flight mutation", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, mutationCount: 1 })).toBe(false);
  });

  it("returns false when an area download is active", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, hasActiveDownload: true })).toBe(false);
  });

  it("returns false when there is unsaved text", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, hasUnsavedText: true })).toBe(false);
  });

  it("returns false when last auto-reload is within the cooldown window", () => {
    expect(
      isSafeToAutoReload({
        ...ALL_CLEAR,
        msSinceLastAutoReload: AUTO_RELOAD_COOLDOWN_MS - 1,
      }),
    ).toBe(false);
  });

  it("returns true when navStatus is idle (all else clear)", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, navStatus: "idle" })).toBe(true);
  });

  it("returns true when navStatus is arrived (all else clear)", () => {
    expect(isSafeToAutoReload({ ...ALL_CLEAR, navStatus: "arrived" })).toBe(true);
  });
});

describe("hasUnsavedTextEntry", () => {
  let input: HTMLInputElement;

  beforeEach(() => {
    input = document.createElement("input");
    document.body.appendChild(input);
  });

  afterEach(() => {
    input.blur();
    document.body.removeChild(input);
  });

  it("returns false when an input is focused but empty", () => {
    input.focus();
    input.value = "";
    expect(hasUnsavedTextEntry()).toBe(false);
  });

  it("returns true when a focused input has a non-empty value", () => {
    input.focus();
    input.value = "x";
    expect(hasUnsavedTextEntry()).toBe(true);
  });

  it("returns false after the input is blurred and removed", () => {
    input.focus();
    input.value = "x";
    input.blur();
    expect(hasUnsavedTextEntry()).toBe(false);
  });
});
