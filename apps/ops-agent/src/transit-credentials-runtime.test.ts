import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { services as coreServices } from "@openmapx/core/server";

const { CONFIGURATION_GENERATIONS, CURRENT_CONFIGURATION, GENERATED_SECRETS_DIRNAME } =
  coreServices;

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
  mkdirSync(join(catalog, "feeds"), { mode: 0o755, recursive: true });
  mkdirSync(join(atlas, "feeds"), { mode: 0o755, recursive: true });
  mkdirSync(local, { mode: 0o755, recursive: true });
  git(atlas, ["init"]);
  writeFileSync(
    join(atlas, "feeds/a.dmfr.json"),
    JSON.stringify({ feeds: [{ id: "auth", authorization: { type: "api-key" } }] }),
    { mode: 0o644 },
  );
  git(atlas, ["add", "."]);
  git(atlas, ["commit", "-m", "Atlas"]);
  const atlasSha = git(atlas, ["rev-parse", "HEAD"]);
  git(catalog, ["init"]);
  writeFileSync(
    join(catalog, "feeds/de.json"),
    JSON.stringify({ sources: [{ name: "A", "transitland-atlas-id": "auth" }] }),
    { mode: 0o644 },
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
    { mode: 0o644 },
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
    { mode: 0o644 },
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
  let running = false;
  let consumer: Record<string, unknown> = { Config: { Env: [] }, Mounts: [] };
  const runtime = createUnavailableRuntime();
  installTransitCredentialsRuntime(runtime, {
    rootDir: root,
    sourceToken: "synthetic-private-inspection-token",
    stack: {
      infraDir,
      composePath: join(infraDir, "docker-compose.generated.yml"),
      composeReleasePath: join(infraDir, "docker-compose.release.yml"),
    },
    ownedServices: {
      inspectOwnedServices: async () =>
        running
          ? [
              {
                serviceId: "data-manager",
                containerId: "dm-owned",
                state: "running",
                provenance: {
                  project: "fixture",
                  composeWorkingDirectory: infraDir,
                  composeConfigFiles: [],
                  imageId: "sha256:" + "a".repeat(64),
                },
              },
            ]
          : [],
    },
    execFile: async (_file, args) => {
      if (args[0] === "container") return { stdout: JSON.stringify(consumer), stderr: "" };
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
    setConsumer: (value: Record<string, unknown>) => {
      running = true;
      consumer = value;
    },
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
it("reads and masks managed credentials from the protected current generation", async () => {
  const f = await fixture(),
    infra = join(f.root, "infra/docker"),
    revision = `cfg1_${"a".repeat(43)}`,
    generation = join(infra, CONFIGURATION_GENERATIONS, revision),
    secretDir = join(generation, GENERATED_SECRETS_DIRNAME, "data-manager"),
    current = join(infra, CURRENT_CONFIGURATION);
  mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(secretDir, "TRANSITOUS_API_KEYS"),
    JSON.stringify({ "de/A": "synthetic-managed-private" }),
    { mode: 0o444 },
  );
  symlinkSync(relative(dirname(current), generation), current);
  f.setEnv({ TRANSITOUS_API_KEYS_FILE: "/run/secrets/TRANSITOUS_API_KEYS" });
  const value = await f.inspect();
  expect(value).toMatchObject({ owner: "vault", editable: true, configuredKeys: ["de/A"] });
  expect(JSON.stringify(value)).not.toContain("synthetic-managed-private");
}, 60000);
it("refuses malformed existing files rather than treating the vault as unset", async () => {
  const f = await fixture();
  writeFileSync(join(f.local, "api-keys.json"), '{"key":"first","key":"last"}', { mode: 0o600 });
  await expect(f.inspect()).rejects.toThrow();
}, 60_000);

it("binds the host credential revision only to the running consumer's exact read-only mount", async () => {
  const f = await fixture();
  writeFileSync(join(f.local, "api-keys.json"), '{"de/A":"private"}', { mode: 0o600 });
  const own = {
    Config: { Env: [] },
    Mounts: [{ Source: f.local, Destination: "/config/transitous", RW: false }],
  };
  f.setConsumer(own);
  const observed = await f.inspect();
  expect(observed).toMatchObject({
    owner: "file",
    consumedCredentialsRevision: observed.hostCredentialsRevision,
  });
  expect(observed.consumedCredentialsRevision).toMatch(/^[a-f0-9]{64}$/);
  f.setConsumer({
    ...own,
    Mounts: [{ Source: f.local, Destination: "/config/transitous", RW: true }],
  });
  expect((await f.inspect()).consumedCredentialsRevision).toBeNull();
  f.setConsumer({ ...own, Config: { Env: ["TRANSITOUS_API_KEYS_PATH=/other/map.json"] } });
  expect((await f.inspect()).consumedCredentialsRevision).toBeNull();
}, 60_000);

it("invalidates the host source version after an identical atomic template replacement", async () => {
  const f = await fixture(),
    target = join(f.local, "api-keys.json"),
    bytes = '{"de/A":"private"}';
  writeFileSync(target, bytes, { mode: 0o600 });
  const before = await f.inspect();
  writeFileSync(target + ".next", bytes, { mode: 0o600 });
  renameSync(target + ".next", target);
  const after = await f.inspect();
  expect(after.hostCredentialsRevision).not.toBe(before.hostCredentialsRevision);
}, 60_000);
