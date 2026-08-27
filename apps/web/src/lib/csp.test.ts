import { describe, expect, it } from "vitest";
import { buildCsp, cspNonce } from "./csp";

const NONCE = "dGVzdC1ub25jZS0xMjM0";

const directive = (csp: string, name: string) =>
  csp.split("; ").find((part) => part.startsWith(`${name} `) || part === name) ?? "";

describe("cspNonce", () => {
  it("is different every time", () => {
    const nonces = new Set(Array.from({ length: 64 }, () => cspNonce()));

    // A nonce that is not per-request is not a nonce; it is a shared secret an
    // attacker reads off the response before using it.
    expect(nonces.size).toBe(64);
  });

  it("is base64 of at least 128 bits", () => {
    const nonce = cspNonce();

    expect(nonce).toMatch(/^[A-Za-z0-9+/]+=*$/);
    expect(atob(nonce).length).toBeGreaterThanOrEqual(16);
  });
});

describe("buildCsp in production", () => {
  const csp = buildCsp(NONCE);

  it("nonces the script source", () => {
    expect(directive(csp, "script-src")).toContain(`'nonce-${NONCE}'`);
  });

  it.each(["'unsafe-inline'", "'unsafe-eval'", "data:", "http:"])(
    "keeps %s out of script-src",
    (keyword) => {
      // Each of these turns the policy back into a suggestion.
      expect(directive(csp, "script-src")).not.toContain(keyword);
    },
  );

  it.each([
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'self'",
    "form-action 'self'",
  ])("keeps enforcing %s", (expected) => {
    expect(csp).toContain(expected);
  });

  it("blocks framed content outright", () => {
    // Nothing in the product embeds a third-party frame, and an app that never
    // frames anything should say so.
    expect(csp).toContain("frame-src 'none'");
  });

  it("keeps style-src permissive, deliberately", () => {
    // MUI's emotion runtime and MapLibre both write style elements at runtime.
    // Inline style cannot execute, so this is a bounded exception.
    expect(directive(csp, "style-src")).toContain("'unsafe-inline'");
  });

  it("keeps connect-src broad for runtime-configured map and data origins", () => {
    // A self-hoster's tile and data services are not knowable at build time, and
    // a permissive connect-src gives a page no ability to talk to the shell.
    expect(directive(csp, "connect-src")).toContain("https:");
  });
});

describe("buildCsp in development", () => {
  it("permits eval only there", () => {
    const development = buildCsp(NONCE, { development: true });

    // React Refresh compiles components at runtime.
    expect(directive(development, "script-src")).toContain("'unsafe-eval'");
    expect(directive(buildCsp(NONCE), "script-src")).not.toContain("'unsafe-eval'");
  });
});
