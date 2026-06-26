import { describe, expect, it, vi } from "vitest";

// Minimal mocks so importing the module is side-effect free; the assertions
// below exercise the pure helpers (hashUrl, assertAllowedUrl), which don't
// touch the DB, git, or the filesystem.
vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/unused",
  repoPaths: () => ({ communityDir: "/unused" }),
  gitShallowClone: vi.fn(),
  services: {
    findServiceManifestDirs: () => [],
    getProvidedCapabilityNames: () => [],
    validateServiceManifest: () => ({ valid: true, errors: [] }),
  },
}));
vi.mock("simple-git", () => ({ default: () => ({}) }));
vi.mock("../../db", () => ({ db: {} }));
vi.mock("../../db/schema", () => ({ serviceRepository: { hash: "hash" } }));

import { assertAllowedUrl, hashUrl, InvalidRepoUrlError } from "../service-repositories";

describe("hashUrl", () => {
  it("is deterministic", () => {
    expect(hashUrl("https://github.com/x/y")).toBe(hashUrl("https://github.com/x/y"));
  });

  it("differs for different URLs", () => {
    expect(hashUrl("https://github.com/x/y")).not.toBe(hashUrl("https://github.com/x/z"));
  });

  it("returns a 16-char hex string", () => {
    expect(hashUrl("https://example.com")).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("assertAllowedUrl", () => {
  it("accepts https URLs on allowlisted hosts", () => {
    expect(() => assertAllowedUrl("https://github.com/owner/repo")).not.toThrow();
    expect(() => assertAllowedUrl("https://gitlab.com/owner/repo")).not.toThrow();
    expect(() => assertAllowedUrl("https://codeberg.org/owner/repo")).not.toThrow();
  });

  it("rejects http://", () => {
    expect(() => assertAllowedUrl("http://github.com/owner/repo")).toThrow(InvalidRepoUrlError);
  });

  it("rejects file:// (local path leak vector)", () => {
    expect(() => assertAllowedUrl("file:///etc/passwd")).toThrow(InvalidRepoUrlError);
  });

  it("rejects ssh://", () => {
    expect(() => assertAllowedUrl("ssh://git@github.com/owner/repo")).toThrow(InvalidRepoUrlError);
  });

  it("rejects unknown hosts even over https", () => {
    expect(() => assertAllowedUrl("https://random.example.com/repo")).toThrow(InvalidRepoUrlError);
  });

  it("rejects malformed URLs", () => {
    expect(() => assertAllowedUrl("not-a-url")).toThrow(InvalidRepoUrlError);
  });
});
