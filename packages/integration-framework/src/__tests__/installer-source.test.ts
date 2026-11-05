import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

const clone = vi.hoisted(() => vi.fn());
vi.mock("@openmapx/core/server", async (actual) => ({
  ...(await actual<typeof import("@openmapx/core/server")>()),
  gitShallowCloneSnapshot: clone,
}));

import {
  createIntegrationArtifactPreparation,
  prepareIntegrationSource,
  publishPreparedIntegration,
  settleIntegrationPublication,
} from "../installer";

const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
  clone.mockReset();
});
it("retains the once-resolved source commit through actual declarative publication", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-source-preparation-"));
  roots.push(root);
  mkdirSync(join(root, "services"));
  clone.mockImplementation(async ({ targetDir }: { targetDir: string }) => {
    mkdirSync(targetDir, { mode: 0o755 });
    writeFileSync(
      join(targetDir, "manifest.json"),
      JSON.stringify({
        id: "source-fixture",
        name: "Source",
        version: "1.0.0",
        platform: "1.0",
        quality: "community",
        domains: ["map-overlay"],
      }),
      { mode: 0o644 },
    );
    return {
      directory: targetDir,
      canonicalUrl: "https://github.com/public/fixture.git",
      commit: "a".repeat(40),
    };
  });
  const signal = new AbortController().signal;
  const result = await prepareIntegrationSource(
    { repository: "https://github.com/public/fixture.git", ref: "main", signal },
    createIntegrationArtifactPreparation({ rootDir: root }),
  );
  expect(result).toMatchObject({
    commit: "a".repeat(40),
    prepared: { id: "source-fixture", archiveSha256: null },
  });
  clone.mockRejectedValue(new Error("Mutable branch now points elsewhere"));
  const publication = await publishPreparedIntegration(result.prepared, {
    transactionId: "9a0826b5-4478-4b9d-88b8-a3bc1b9755f6",
    expectedPreviousContentDigest: null,
    signal,
  });
  await settleIntegrationPublication(publication, "commit", signal);
  expect(clone).toHaveBeenCalledTimes(1);
  expect(
    JSON.parse(
      readFileSync(join(root, "custom_integrations", "source-fixture", "manifest.json"), "utf8"),
    ).id,
  ).toBe("source-fixture");
});
it("rejects executable source without publishing it", async () => {
  const root = mkdtempSync(join(tmpdir(), "openmapx-source-rejection-"));
  roots.push(root);
  mkdirSync(join(root, "services"));
  clone.mockImplementation(async ({ targetDir }: { targetDir: string }) => {
    mkdirSync(targetDir);
    writeFileSync(
      join(targetDir, "manifest.json"),
      JSON.stringify({
        id: "source-fixture",
        name: "Source",
        version: "1.0.0",
        platform: "1.0",
        quality: "community",
        domains: ["map-overlay"],
      }),
    );
    writeFileSync(join(targetDir, "index.js"), "throw Error('never execute')");
    return {
      directory: targetDir,
      canonicalUrl: "https://github.com/public/fixture.git",
      commit: "a".repeat(40),
    };
  });
  await expect(
    prepareIntegrationSource(
      { repository: "https://github.com/public/fixture.git", signal: new AbortController().signal },
      createIntegrationArtifactPreparation({ rootDir: root }),
    ),
  ).rejects.toThrow(/code|declarative|executable/i);
});
