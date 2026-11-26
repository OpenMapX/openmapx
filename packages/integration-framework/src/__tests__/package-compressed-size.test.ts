import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const MAX_ARTIFACT_BYTES = 200 * 1024 * 1024;

// Reaching the limit for real takes 200 MiB of incompressible content; the
// archive writer stands in for it with output one byte over the limit.
vi.mock("../deterministic-tar", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../deterministic-tar")>();
  return { ...actual, createDeterministicTarGz: () => Buffer.alloc(MAX_ARTIFACT_BYTES + 1) };
});

const { packageIntegration } = await import("../installer");

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it("refuses to write an artifact whose compressed size no install accepts", async () => {
  const source = mkdtempSync(join(tmpdir(), "openmapx-package-src-"));
  const out = mkdtempSync(join(tmpdir(), "openmapx-package-out-"));
  roots.push(source, out);
  writeFileSync(
    join(source, "manifest.json"),
    JSON.stringify({
      id: "fixture-integration",
      name: "Fixture",
      version: "1.0.0",
      platform: "1.0",
      description: "Fixture integration used by the packaging size test.",
      domains: ["fixture"],
    }),
  );
  mkdirSync(join(source, "assets"));
  writeFileSync(join(source, "assets", "tile.webp"), "already compressed");
  const target = join(out, "nested", "artifact.tar.gz");

  await expect(packageIntegration({ rootDir: source, source, outFile: target })).rejects.toThrow(
    `Artifact would be ${MAX_ARTIFACT_BYTES + 1} bytes; an install accepts at most ${MAX_ARTIFACT_BYTES}`,
  );
  expect(existsSync(join(out, "nested"))).toBe(false);
});
