import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { prepareIntegrationCodeCache } from "../integration-code-cache";

const require = createRequire(import.meta.url);
const hostSdk = realpathSync(dirname(require.resolve("@openmapx/integration-sdk/package.json")));
const hostZod = realpathSync(
  dirname(createRequire(join(hostSdk, "package.json")).resolve("zod/package.json")),
);

const roots: string[] = [];

function freshRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "omx-cache-"));
  roots.push(root);
  return root;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe("integration code cache", () => {
  const cache = prepareIntegrationCodeCache({ root: freshRoot() });
  const bytes = Buffer.from("export const x = 1;\n");
  const sha = createHash("sha256").update(bytes).digest("hex");

  it("writes verified bytes under id and hash and links the host packages", () => {
    const path = cache.materialize("demo-engine", sha, bytes);
    expect(path).toBe(join(cache.root, "demo-engine", sha, "index.mjs"));
    expect(readFileSync(path)).toEqual(bytes);
    expect(statSync(path).mode & 0o777).toBe(0o400);
    expect(statSync(cache.root).mode & 0o777).toBe(0o700);
    const sdkLink = join(cache.root, "node_modules/@openmapx/integration-sdk");
    const zodLink = join(cache.root, "node_modules/zod");
    expect(lstatSync(sdkLink).isSymbolicLink()).toBe(true);
    expect(lstatSync(zodLink).isSymbolicLink()).toBe(true);
    // The links must reach the host's own copies; a link to a copy would give
    // bundles separate module instances.
    expect(realpathSync(sdkLink)).toBe(hostSdk);
    expect(realpathSync(zodLink)).toBe(hostZod);
  });

  it("returns the existing file when the same bytes arrive again", () => {
    const first = cache.materialize("demo-engine", sha, bytes);
    expect(cache.materialize("demo-engine", sha, bytes)).toBe(first);
    expect(readFileSync(first)).toEqual(bytes);
  });

  it("refuses bytes that do not match the hash", () => {
    expect(() => cache.materialize("demo-engine", "0".repeat(64), Buffer.from("x"))).toThrow(
      /does not match/,
    );
  });

  it("refuses an id that could leave the cache", () => {
    expect(() => cache.materialize("../x", sha, bytes)).toThrow(/integration id/);
  });

  it("starts empty at each prepare", () => {
    const root = freshRoot();
    const first = prepareIntegrationCodeCache({ root });
    first.materialize("demo-engine", sha, bytes);
    expect(existsSync(join(root, "demo-engine"))).toBe(true);

    const second = prepareIntegrationCodeCache({ root });
    expect(second.root).toBe(first.root);
    expect(existsSync(join(root, "demo-engine"))).toBe(false);
    expect(lstatSync(join(root, "node_modules/zod")).isSymbolicLink()).toBe(true);
  });

  it("resolves a relative root to an absolute one", () => {
    const absolute = join(freshRoot(), "relative-cache");
    const relativeCache = prepareIntegrationCodeCache({ root: relative(process.cwd(), absolute) });
    expect(relativeCache.root).toBe(absolute);
    expect(isAbsolute(relativeCache.materialize("demo-engine", sha, bytes))).toBe(true);
  });

  it("treats an empty cache directory setting as unset", () => {
    const temporary = freshRoot();
    vi.stubEnv("OPENMAPX_INTEGRATION_CODE_CACHE_DIR", "");
    vi.stubEnv("TMPDIR", temporary);
    try {
      expect(prepareIntegrationCodeCache().root).toBe(join(temporary, "openmapx-integration-code"));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("refuses to delete a directory it did not prepare", () => {
    const foreign = freshRoot();
    writeFileSync(join(foreign, "keep.txt"), "operator data");
    expect(() => prepareIntegrationCodeCache({ root: foreign })).toThrow(/refusing to delete/);
    expect(readFileSync(join(foreign, "keep.txt"), "utf8")).toBe("operator data");
  });

  it("refuses the filesystem root", () => {
    expect(() => prepareIntegrationCodeCache({ root: "/" })).toThrow(/filesystem root/);
  });
});
