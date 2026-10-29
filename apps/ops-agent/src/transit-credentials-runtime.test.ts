import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { initializeManagedCatalogPins, readCatalogPinSet } from "@openmapx/core/catalog-pins";
import { afterEach, expect, it } from "vitest";
import { testExecution } from "./__fixtures__/execution";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { installTransitCredentialsRuntime } from "./transit-credentials-runtime";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, args: string[]) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.test",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.test",
    },
  }).trim();
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "omx-transit-credentials-runtime-"));
  roots.push(root);
  const infraDir = join(root, "infra/docker"),
    catalog = join(infraDir, "data/.transitous-catalog"),
    atlas = join(catalog, "transitland-atlas"),
    local = join(root, "services/motis/tools/transitous");
  mkdirSync(join(catalog, "feeds"), { recursive: true });
  mkdirSync(join(atlas, "feeds"), { recursive: true });
  mkdirSync(local, { recursive: true });
  git(atlas, ["init"]);
  writeFileSync(
    join(atlas, "feeds/a.dmfr.json"),
    JSON.stringify({ feeds: [{ id: "auth", authorization: { type: "api-key" } }] }),
  );
  git(atlas, ["add", "."]);
  git(atlas, ["commit", "-m", "Atlas"]);
  const atlasSha = git(atlas, ["rev-parse", "HEAD"]);
  git(catalog, ["init"]);
  writeFileSync(
    join(catalog, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "A", "transitland-atlas-id": "auth" }] }),
  );
  git(catalog, ["add", "feeds"]);
  git(catalog, ["update-index", "--add", "--cacheinfo", `160000,${atlasSha},transitland-atlas`]);
  git(catalog, ["commit", "-m", "Transitous"]);
  const sha = git(catalog, ["rev-parse", "HEAD"]);
  writeFileSync(
    join(infraDir, "transitous.lock.json"),
    JSON.stringify({
      ref: `main@${sha}`,
      submodules: { "transitland-atlas": atlasSha },
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    }),
  );
  const gbfs = "b".repeat(40);
  writeFileSync(
    join(infraDir, "gbfs-catalog.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: gbfs,
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${gbfs}/systems.csv`,
      sha256: "c".repeat(64),
      lockedAt: "2026-10-23T00:00:00.000Z",
      lockedBy: "fixture",
    }),
  );
  await provisionControlInstallation(infraDir);
  const installation = openControlInstallation({
    infraDir,
    role: "ops-agent",
    serviceIds: ["motis", "data-manager"],
  });
  try {
    await initializeManagedCatalogPins({ rootDir: root, installation });
  } finally {
    closeControlInstallation(installation);
  }
  const operation = {
    kind: "transitCredentials.inspect" as const,
    catalogRevisionId: readCatalogPinSet(root)!.generationId,
  };
  let environment: Record<string, string> = {};
  const runtime = createUnavailableRuntime();
  installTransitCredentialsRuntime(runtime, {
    rootDir: root,
    sourceToken: "synthetic-private-inspection-token",
    stack: {
      infraDir,
      composePath: join(infraDir, "docker-compose.generated.yml"),
      composeReleasePath: join(infraDir, "docker-compose.release.yml"),
    },
    ownedServices: { inspectOwnedServices: async () => [] },
    execFile: async (_file, args) => {
      expect(args).toContain("config");
      return {
        stdout: JSON.stringify({ services: { "data-manager": { environment } } }),
        stderr: "",
      };
    },
  });
  const inspect = () =>
    dispatchOpsOperation(runtime, operation, {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog: () => {},
      claim: {
        operation,
        fingerprint: "a".repeat(64),
        source: "registry",
        capability: { revisionId: "fixture", values: {} },
      },
    });
  return {
    root,
    local,
    inspect,
    setEnv: (value: Record<string, string>) => {
      environment = value;
    },
  };
}
it("discovers pinned keys and masks host-file values without adopting or modifying them", async () => {
  const f = await fixture();
  expect(await f.inspect()).toMatchObject({
    requiredKeys: ["de/A"],
    owner: "unset",
    editable: true,
    configuredKeys: [],
  });
  const file = join(f.local, "api-keys.json"),
    bytes = '{"de/A":"sensitive","orphan":"still-sensitive","blank/orphan":""}';
  writeFileSync(file, bytes, { mode: 0o600 });
  const result = await f.inspect();
  expect(result).toMatchObject({
    owner: "file",
    editable: false,
    configuredKeys: ["de/A", "orphan"],
    retainedKeys: ["blank/orphan", "de/A", "orphan"],
  });
  expect(JSON.stringify(result)).not.toContain("sensitive");
  expect(readFileSync(file, "utf8")).toBe(bytes);
  expect(result.hostCredentialsRevision).toMatch(/^[a-f0-9]{64}$/);
  expect((await f.inspect()).hostCredentialsRevision).toBe(result.hostCredentialsRevision);
  writeFileSync(file, '{"de/A":"rotated","orphan":"still-sensitive"}', { mode: 0o600 });
  expect((await f.inspect()).hostCredentialsRevision).not.toBe(result.hostCredentialsRevision);
  f.setEnv({ TRANSITOUS_API_KEYS_PATH: "/operator/custom.json" });
  expect(await f.inspect()).toMatchObject({
    owner: "environment",
    editable: false,
    configuredKeys: [],
  });
}, 60_000);
it("refuses malformed existing files rather than treating the vault as unset", async () => {
  const f = await fixture();
  writeFileSync(join(f.local, "api-keys.json"), '{"key":"first","key":"last"}', { mode: 0o600 });
  await expect(f.inspect()).rejects.toThrow();
}, 60_000);
