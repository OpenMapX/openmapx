import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertAllowedUrl, hashUrl, InvalidRepoUrlError } from "../service-repositories";

// One real temp dir stands in for communityDir(); each test writes a
// service.json into <tmp>/<hash>/<slug>/ so the private readPreviewsFromClone
// reads real files. validateServiceManifest is mocked to decide pass/fail.
const tmpCommunityDir = mkdtempSync(join(tmpdir(), "svc-repo-test-"));
const validateMock = vi.fn();

vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/unused",
  repoPaths: () => ({ communityDir: tmpCommunityDir }),
  gitShallowCloneAtomic: vi.fn(),
  services: {
    validateServiceManifest: (raw: unknown) => validateMock(raw),
    getProvidedCapabilityNames: () => [],
  },
}));

const gitFetch = vi.fn().mockResolvedValue(undefined);
const gitReset = vi.fn().mockResolvedValue(undefined);
const gitRevparse = vi.fn();
vi.mock("simple-git", () => ({
  default: () => ({ fetch: gitFetch, reset: gitReset, revparse: gitRevparse }),
}));

const selectLimitMock = vi.fn();
const updateReturningMock = vi.fn();
vi.mock("../../db", () => {
  const limit = (...a: unknown[]) => selectLimitMock(...a);
  const selectWhere = () => ({ limit });
  const select = () => ({ from: () => ({ where: selectWhere }) });
  const returning = (...a: unknown[]) => updateReturningMock(...a);
  const updateWhere = () => ({ returning });
  const update = () => ({ set: () => ({ where: updateWhere }) });
  return { db: { select, update } };
});

vi.mock("../../db/schema", () => ({ serviceRepository: { hash: "hash" } }));

// Import AFTER mocks are registered.
import { refreshRepo } from "../service-repositories";

const HASH = "aaaaaaaaaaaaaaaa"; // 16 hex chars — passes assertRepoHash

function writeManifest(slug: string) {
  const dir = join(tmpCommunityDir, HASH, slug);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "service.json"),
    JSON.stringify({ id: slug, name: slug, version: "1.0.0", quality: "community" }),
  );
}

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
    expect(() => assertAllowedUrl("https://bitbucket.org/owner/repo")).not.toThrow();
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

  it("returns a parsed URL on success", () => {
    const u = assertAllowedUrl("https://github.com/owner/repo.git");
    expect(u.host).toBe("github.com");
    expect(u.pathname).toBe("/owner/repo.git");
  });
});

describe("refreshRepo re-validates after update", () => {
  beforeEach(() => {
    gitFetch.mockClear();
    gitReset.mockClear();
    gitRevparse.mockReset();
    selectLimitMock.mockReset();
    updateReturningMock.mockReset();
    validateMock.mockReset();
    writeManifest("svc");
  });

  it("returns null for an unknown repo hash (no git touched)", async () => {
    selectLimitMock.mockResolvedValueOnce([]);
    const r = await refreshRepo(HASH);
    expect(r).toBeNull();
    expect(gitFetch).not.toHaveBeenCalled();
  });

  it("updates lastSha when the refreshed clone validates clean", async () => {
    selectLimitMock.mockResolvedValueOnce([{ hash: HASH, lastSha: "oldsha" }]);
    gitRevparse
      .mockResolvedValueOnce("oldsha\n") // prevSha (before reset)
      .mockResolvedValueOnce("newsha\n"); // post-validation sha
    validateMock.mockReturnValue({ valid: true, errors: [] });
    updateReturningMock.mockResolvedValueOnce([{ hash: HASH, lastSha: "newsha" }]);

    const r = await refreshRepo(HASH);

    expect(r).toEqual({ hash: HASH, lastSha: "newsha" });
    expect(gitReset).toHaveBeenCalledTimes(1); // only the origin/HEAD reset
    expect(gitReset).toHaveBeenCalledWith(["--hard", "origin/HEAD"]);
    expect(updateReturningMock).toHaveBeenCalledTimes(1);
  });

  it("rolls back and throws when the refreshed clone fails validation", async () => {
    selectLimitMock.mockResolvedValueOnce([{ hash: HASH, lastSha: "oldsha" }]);
    gitRevparse.mockResolvedValueOnce("oldsha\n"); // prevSha; second revparse never reached
    validateMock.mockReturnValue({
      valid: false,
      errors: ["container.capAdd: 'SYS_ADMIN' not allowed"],
    });

    await expect(refreshRepo(HASH)).rejects.toBeInstanceOf(InvalidRepoUrlError);

    // rolled the working tree back to prevSha …
    expect(gitReset).toHaveBeenCalledWith(["--hard", "origin/HEAD"]);
    expect(gitReset).toHaveBeenCalledWith(["--hard", "oldsha"]);
    expect(gitReset).toHaveBeenCalledTimes(2);
    // … and never advanced the DB.
    expect(updateReturningMock).not.toHaveBeenCalled();
  });
});
