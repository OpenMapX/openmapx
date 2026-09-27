import { describe, expect, it } from "vitest";
import { resolveBetterAuthSecret } from "./auth-secret";

describe("resolveBetterAuthSecret", () => {
  it("requires a configured secret in every environment", () => {
    expect(() => resolveBetterAuthSecret({ NODE_ENV: "development" })).toThrow(
      /BETTER_AUTH_SECRET env var is required/,
    );
  });

  it("rejects weak production secrets", () => {
    expect(() =>
      resolveBetterAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: "short" }),
    ).toThrow(/BETTER_AUTH_SECRET.*too-short.*32/);
  });

  it("returns a strong production secret unchanged", () => {
    const secret = " strong-production-secret-with-spaces ";
    expect(resolveBetterAuthSecret({ NODE_ENV: "production", BETTER_AUTH_SECRET: secret })).toBe(
      secret,
    );
  });

  it("preserves existing development compatibility", () => {
    expect(resolveBetterAuthSecret({ NODE_ENV: "development", BETTER_AUTH_SECRET: "local" })).toBe(
      "local",
    );
  });
});
