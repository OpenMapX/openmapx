import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { prepareIntegrationCodeCache } from "../integration-code-cache";

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
    expect(
      lstatSync(join(cache.root, "node_modules/@openmapx/integration-sdk")).isSymbolicLink(),
    ).toBe(true);
    expect(realpathSync(join(cache.root, "node_modules/zod/package.json"))).toMatch(
      /zod[\\/]package\.json$/,
    );
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
});
