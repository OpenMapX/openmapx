import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { assertAllowedUrl, hashUrl, InvalidRepoUrlError } from "../service-repositories";

// One real temp dir stands in for communityDir(). The mocked gitShallowClone
// materializes a fresh "clone" (a <tmp>/<slug>/service.json) into the targetDir
// it's handed, so the private readPreviewsFromClone reads real files.
// validateServiceManifest is mocked to decide pass/fail.
const tmpCommunityDir = mkdtempSync(join(tmpdir(), "svc-repo-test-"));
const validateMock = vi.fn();

// Mocked clone: write a service.json into the requested targetDir and return it.
const gitShallowCloneMock = vi.fn(async (opts: { targetDir?: string }) => {
  const dir = opts.targetDir ?? join(tmpCommunityDir, "fallback-tmp");
  mkdirSync(join(dir, "svc"), { recursive: true });
  writeFileSync(
    join(dir, "svc", "service.json"),
    JSON.stringify({ id: "svc", name: "svc", version: "1.0.0", quality: "community" }),
  );
  return dir;
});

vi.mock("@openmapx/core/server", () => ({
  findRepoRoot: () => "/unused",
  repoPaths: () => ({ communityDir: tmpCommunityDir }),
  gitShallowClone: (opts: { targetDir?: string }) => gitShallowCloneMock(opts),
  services: {
    validateServiceManifest: (raw: unknown) => validateMock(raw),
    getProvidedCapabilityNames: () => [],
    // Fixtures live one level deep (<dir>/<slug>/service.json); a shallow scan
    // matches them. The deep-walk behaviour is covered by manifest-discovery's
    // own unit tests.
    findServiceManifestDirs: (root: string) =>
      readdirSync(root, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => join(root, e.name))
        .filter((d) => existsSync(join(d, "service.json"))),
  },
}));

const gitRevparse = vi.fn();
vi.mock("simple-git", () => ({
  default: () => ({ revparse: gitRevparse }),
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

vi.mock("../../db/schema", () => ({
  serviceRepository: { hash: "hash", managedByExtension: "managed_by_extension" },
}));

// Import AFTER mocks are registered.
import { refreshRepo } from "../service-repositories";

const HASH = "aaaaaaaaaaaaaaaa"; // 16 hex chars — passes assertRepoHash

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

describe("refreshRepo re-clones and re-validates", () => {
  beforeEach(() => {
    gitShallowCloneMock.mockClear();
    gitRevparse.mockReset();
    selectLimitMock.mockReset();
    updateReturningMock.mockReset();
    validateMock.mockReset();
  });

  it("returns null for an unknown repo hash (no clone touched)", async () => {
    selectLimitMock.mockResolvedValueOnce([]);
    const r = await refreshRepo(HASH);
    expect(r).toBeNull();
    expect(gitShallowCloneMock).not.toHaveBeenCalled();
  });

  it("refuses to refresh an extension-managed repo", async () => {
    selectLimitMock.mockResolvedValueOnce([
      { hash: HASH, url: "https://github.com/x/y", managedByExtension: "openconditions" },
    ]);
    await expect(refreshRepo(HASH)).rejects.toBeInstanceOf(InvalidRepoUrlError);
    expect(gitShallowCloneMock).not.toHaveBeenCalled();
  });

  it("updates lastSha when the refreshed clone validates clean", async () => {
    selectLimitMock.mockResolvedValueOnce([
      { hash: HASH, url: "https://github.com/x/y", lastSha: "oldsha", managedByExtension: null },
    ]);
    gitRevparse.mockResolvedValueOnce("newsha\n");
    validateMock.mockReturnValue({ valid: true, errors: [] });
    updateReturningMock.mockResolvedValueOnce([{ hash: HASH, lastSha: "newsha" }]);

    const r = await refreshRepo(HASH);

    expect(r).toEqual({ hash: HASH, lastSha: "newsha" });
    expect(gitShallowCloneMock).toHaveBeenCalledTimes(1);
    expect(updateReturningMock).toHaveBeenCalledTimes(1);
  });

  it("throws and does not advance the DB when validation fails", async () => {
    selectLimitMock.mockResolvedValueOnce([
      { hash: HASH, url: "https://github.com/x/y", lastSha: "oldsha", managedByExtension: null },
    ]);
    gitRevparse.mockResolvedValueOnce("newsha\n");
    validateMock.mockReturnValue({
      valid: false,
      errors: ["container.capAdd: 'SYS_ADMIN' not allowed"],
    });

    await expect(refreshRepo(HASH)).rejects.toBeInstanceOf(InvalidRepoUrlError);
    expect(updateReturningMock).not.toHaveBeenCalled();
  });
});
