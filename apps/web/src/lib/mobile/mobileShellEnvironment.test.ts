import { describe, expect, it } from "vitest";
import {
  CHANNEL_GLOBAL,
  isInstalledShell,
  readShellDescriptor,
  readShellTransport,
  shellFeatureBoundary,
} from "./mobileShellEnvironment";

function scopeWith(overrides: Record<string, unknown> = {}) {
  return { ...overrides };
}

const shell = () =>
  scopeWith({
    [CHANNEL_GLOBAL]: { nonce: "abc123" },
    ReactNativeWebView: { postMessage: () => undefined },
  });

describe("readShellDescriptor", () => {
  it("reads a well-formed descriptor", () => {
    expect(readShellDescriptor(shell())).toEqual({ nonce: "abc123" });
  });

  it("has none in an ordinary browser", () => {
    expect(readShellDescriptor(scopeWith())).toBeNull();
  });

  it.each([
    { label: "a non-object", value: "abc123" },
    { label: "null", value: null },
    { label: "an empty object", value: {} },
    { label: "a non-string nonce", value: { nonce: 42 } },
    { label: "an empty nonce", value: { nonce: "" } },
  ])("treats $label as absent", ({ value }) => {
    // A partially-formed descriptor is more likely tampering or a bug than a
    // shell, and neither deserves the trust the real one gets.
    expect(readShellDescriptor(scopeWith({ [CHANNEL_GLOBAL]: value }))).toBeNull();
  });
});

describe("readShellTransport", () => {
  it("reads the transport the shell installs", () => {
    expect(readShellTransport(shell())).toBeTruthy();
  });

  it("has none in an ordinary browser", () => {
    expect(readShellTransport(scopeWith())).toBeNull();
  });

  it("refuses a transport that cannot post", () => {
    expect(readShellTransport(scopeWith({ ReactNativeWebView: {} }))).toBeNull();
    expect(readShellTransport(scopeWith({ ReactNativeWebView: { postMessage: 42 } }))).toBeNull();
  });
});

describe("isInstalledShell", () => {
  it("is true from the very first render inside the shell", () => {
    expect(isInstalledShell(shell())).toBe(true);
  });

  it("is false in an ordinary browser", () => {
    expect(isInstalledShell(scopeWith())).toBe(false);
  });

  it("is true even when the transport is missing", () => {
    // "We are in the app" and "the app can run navigation" are different
    // questions. A shell whose bridge is broken is still a shell, and must not
    // fall back to browser behaviour it is not allowed to have.
    expect(isInstalledShell(scopeWith({ [CHANNEL_GLOBAL]: { nonce: "abc" } }))).toBe(true);
  });
});

describe("shellFeatureBoundary", () => {
  it("changes nothing for an ordinary browser", () => {
    const boundary = shellFeatureBoundary(scopeWith());

    for (const value of Object.values(boundary)) expect(value).toBe(true);
  });

  it.each([
    "communityFrontendBundles",
    "microphone",
    "browserGeolocationWatch",
    "browserSpeech",
    "browserNotifications",
    "browserSessionPersistence",
    "browserWakeLock",
  ] as const)("removes %s inside the shell", (feature) => {
    expect(shellFeatureBoundary(shell())[feature]).toBe(false);
  });

  it("removes them before any handshake has happened", () => {
    // Deferring until negotiation completes would leave a window in which
    // unreviewed code had already run.
    const negotiating = scopeWith({ [CHANNEL_GLOBAL]: { nonce: "abc" } });

    expect(shellFeatureBoundary(negotiating).communityFrontendBundles).toBe(false);
    expect(shellFeatureBoundary(negotiating).microphone).toBe(false);
  });

  it("keeps them removed when the bridge turns out to be incompatible", () => {
    // An old shell that cannot run navigation is still an installed binary.
    expect(shellFeatureBoundary(shell()).communityFrontendBundles).toBe(false);
  });
});
