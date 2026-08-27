import { describe, expect, it } from "vitest";
import { assertAllowedGitUrl, canonicalGitUrl, InvalidGitUrlError } from "../git-url";

const SECRET = "fixture-git-token";

describe("assertAllowedGitUrl", () => {
  it("accepts and canonicalizes a plain allowlisted https URL", () => {
    expect(canonicalGitUrl("https://GitHub.com:443/OpenMapX/Repo.git")).toBe(
      "https://github.com/OpenMapX/Repo.git",
    );
    expect(canonicalGitUrl("https://github.com/openmapx/repo")).toBe(
      "https://github.com/openmapx/repo",
    );
  });

  it("rejects userinfo without echoing the credential", () => {
    for (const url of [
      `https://user:${SECRET}@github.com/o/r.git`,
      `https://${SECRET}@github.com/o/r.git`,
      `https://user%3A${SECRET}@github.com/o/r.git`,
    ]) {
      let message = "";
      try {
        assertAllowedGitUrl(url);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toMatch(/credential/i);
      expect(message).not.toContain(SECRET);
      expect(message).not.toContain("user");
    }
  });

  it("rejects a query string and a fragment", () => {
    expect(() => assertAllowedGitUrl(`https://github.com/o/r.git?token=${SECRET}`)).toThrow(
      InvalidGitUrlError,
    );
    expect(() => assertAllowedGitUrl(`https://github.com/o/r.git#${SECRET}`)).toThrow(
      InvalidGitUrlError,
    );
    let message = "";
    try {
      assertAllowedGitUrl(`https://github.com/o/r.git?token=${SECRET}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET);
  });

  it("normalizes host casing and the default port before the allowlist check", () => {
    expect(() => assertAllowedGitUrl("https://GITHUB.COM/o/r.git")).not.toThrow();
    expect(() => assertAllowedGitUrl("https://github.com:443/o/r.git")).not.toThrow();
    // A non-default port is a different endpoint and is refused.
    expect(() => assertAllowedGitUrl("https://github.com:8443/o/r.git")).toThrow(
      InvalidGitUrlError,
    );
  });

  it("rejects an unsupported protocol and a non-allowlisted host", () => {
    expect(() => assertAllowedGitUrl("http://github.com/o/r.git")).toThrow(InvalidGitUrlError);
    expect(() => assertAllowedGitUrl("ssh://github.com/o/r.git")).toThrow(InvalidGitUrlError);
    expect(() => assertAllowedGitUrl("file:///etc/passwd")).toThrow(InvalidGitUrlError);
    expect(() => assertAllowedGitUrl("https://evil.example.test/o/r.git")).toThrow(
      InvalidGitUrlError,
    );
  });

  it("names the normalized host but never the raw input for a rejected host", () => {
    let message = "";
    try {
      assertAllowedGitUrl("https://Evil.Example.Test/o/r.git");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("evil.example.test");
    // The raw, differently-cased input is not reflected back.
    expect(message).not.toContain("Evil.Example.Test");
  });

  it("rejects malformed input without echoing it", () => {
    let message = "";
    try {
      assertAllowedGitUrl(`not a url ${SECRET}`);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain(SECRET);
    expect(message).toMatch(/not a valid url/i);
  });

  it("returns a credential-free canonical string identical for equivalent inputs", () => {
    const a = assertAllowedGitUrl("https://github.com/o/r.git");
    const b = assertAllowedGitUrl("https://GitHub.com:443/o/r.git");
    expect(a.canonical).toBe(b.canonical);
    expect(a.canonical).not.toMatch(/@/);
  });
});
