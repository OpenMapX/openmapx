import { execFileSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
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

const { CONFIGURATION_GENERATIONS, CURRENT_CONFIGURATION } = coreServices;

import { createCatalogPinSet } from "@openmapx/core/catalog-pins";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { afterEach, expect, it, vi } from "vitest";
import { run as assemble } from "../../../../services/data-manager/src/jobs/transitous/assemble-staging";
import { run as generate } from "../../../../services/data-manager/src/jobs/transitous/gen-full-config";
import { buildJobContext } from "../../../../services/data-manager/src/jobs/transitous/pipeline";
import { StateStore } from "../../../../services/data-manager/src/state";
import { inspectMotisPortableDestination, materializeMotisPortableDestination } from "./motis";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
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
const stamp = "2026-10-30T00:00:00.000Z",
  sourceKey = "SYNTHETIC_SOURCE_KEY",
  destinationKey = "SYNTHETIC_DESTINATION_KEY";
async function fixture(publicSource = false, actualPinnedTemplate = false) {
  const root = mkdtempSync(join(tmpdir(), "omx-motis-destination-"));
  roots.push(root);
  const infraDir = join(root, "infra/docker"),
    data = join(infraDir, "data"),
    catalog = join(data, ".transitous-catalog"),
    atlas = join(catalog, "transitland-atlas");
  mkdirSync(join(catalog, "feeds"), { mode: 0o755, recursive: true });
  mkdirSync(join(catalog, "src"), { mode: 0o755 });
  mkdirSync(join(catalog, "configs/motis"), { mode: 0o755, recursive: true });
  mkdirSync(join(atlas, "feeds"), { mode: 0o755, recursive: true });
  git(atlas, ["init"]);
  // Deliberately different filename and id: identity is the parsed pinned DMFR id.
  writeFileSync(
    join(atlas, "feeds/operator.dmfr.json"),
    JSON.stringify({
      feeds: [
        {
          id: "f-demo",
          urls: {
            static_current: "https://operator.example/static.zip",
            realtime_trip_updates: "https://operator.example/realtime.pb",
          },
          ...(!publicSource ? { authorization: { type: "header", param_name: "X-Key" } } : {}),
        },
      ],
    }),
    { mode: 0o644 },
  );
  git(atlas, ["add", "."]);
  git(atlas, ["commit", "-m", "Synthetic Atlas"]);
  const atlasCommit = git(atlas, ["rev-parse", "HEAD"]);
  git(catalog, ["init"]);
  writeFileSync(
    join(catalog, "feeds/de.json"),
    JSON.stringify({
      sources: [{ name: "demo", type: "transitland-atlas", "transitland-atlas-id": "f-demo" }],
    }),
    { mode: 0o644 },
  );
  const approvedTemplate = actualPinnedTemplate
    ? readFileSync(
        new URL(
          "../../../../services/data-manager/__tests__/transitous/fixtures/portable-pinned-motis-config.yml",
          import.meta.url,
        ),
        "utf8",
      )
    : "server:\n  port: 8080\ntimetable:\n  datasets: {}\n";
  writeFileSync(join(catalog, "configs/motis/config.yml"), approvedTemplate, { mode: 0o644 });
  writeFileSync(join(catalog, "src/generate-motis-config.py"), "# synthetic generator marker\n", {
    mode: 0o644,
  });
  git(catalog, ["add", "feeds", "configs", "src"]);
  git(catalog, ["update-index", "--add", "--cacheinfo", `160000,${atlasCommit},transitland-atlas`]);
  git(catalog, ["commit", "-m", "Synthetic catalog"]);
  const transitousCommit = git(catalog, ["rev-parse", "HEAD"]);
  const pair = createCatalogPinSet(
    {
      ref: `main@${transitousCommit}`,
      submodules: { "transitland-atlas": atlasCommit },
      lockedAt: stamp,
      lockedBy: "fixture",
    },
    {
      schemaVersion: 1,
      source: "mobilitydata-gbfs",
      commit: "b".repeat(40),
      url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"b".repeat(40)}/systems.csv`,
      sha256: "c".repeat(64),
      lockedAt: stamp,
      lockedBy: "fixture",
    },
  );
  const pinDir = join(infraDir, "catalog-pins");
  mkdirSync(join(pinDir, "generations"), { recursive: true, mode: 0o700 });
  chmodSync(pinDir, 0o700);
  writeFileSync(join(pinDir, "generations", `${pair.generationId}.json`), JSON.stringify(pair), {
    mode: 0o600,
  });
  writeFileSync(
    join(pinDir, "current.json"),
    JSON.stringify({
      version: 1,
      generationId: pair.generationId,
      commitId: randomUUID(),
      operationKey: createControlRootOperationKey({
        notAfter: Date.now() + 60000,
        nonce: randomBytes(16),
      }),
      fingerprint: "d".repeat(64),
      committedAt: stamp,
    }),
    { mode: 0o600 },
  );
  const out = join(data, "gtfs");
  mkdirSync(out, { mode: 0o755 });
  symlinkSync(out, join(catalog, "out"));
  writeFileSync(
    join(out, "config.yml"),
    "server:\n  port: 8080\ntimetable:\n  datasets:\n    de-demo:\n      path: de_demo.gtfs.zip\n      rt:\n        - url: https://rt.triptix.tech/feed/de-demo-0\n          protocol: gtfsrt\n",
    { mode: 0o644 },
  );
  if (actualPinnedTemplate) {
    const generated = approvedTemplate
      .replace(
        /^ {2}datasets:.*$/m,
        "  datasets:\n    de-demo:\n      path: de_demo.gtfs.zip\n      extend_calendar: false\n      rt:\n        - url: https://rt.triptix.tech/feed/de-demo-0\n          protocol: gtfsrt",
      )
      .replace(/^ {2}feeds:.*$/m, "  feeds: {}")
      .replace(/^gbfs:$/m, "gbfs:\n  proxy: https://rt.triptix.tech");
    writeFileSync(join(out, "config.yml"), generated, { mode: 0o644 });
    writeFileSync(join(out, "planet-latest.osm.pbf"), "synthetic OSM input", { mode: 0o644 });
  }
  const archive = "synthetic timetable";
  writeFileSync(join(out, "de_demo.gtfs.zip"), archive, { mode: 0o644 });
  writeFileSync(join(out, "license.json"), "[]", { mode: 0o644 });
  writeFileSync(
    join(out, "transit-source-manifest.json"),
    JSON.stringify({
      version: 1,
      generatedAt: stamp,
      sources: [
        {
          sourceId: "catalog:de:demo",
          region: "de",
          name: "demo",
          format: "gtfs",
          origin: "catalog",
          license: {},
          transformations: [],
          artifact: {
            relativePath: "de_demo.gtfs.zip",
            sha256: createHash("sha256").update(archive).digest("hex"),
            sizeBytes: Buffer.byteLength(archive),
            modifiedAt: stamp,
          },
        },
      ],
    }),
    { mode: 0o644 },
  );
  const sourceKeys = join(root, "source-keys.json");
  writeFileSync(sourceKeys, JSON.stringify({ "de/demo": sourceKey }), { mode: 0o600 });
  const ctx = buildJobContext({
    dataDir: data,
    store: new StateStore(data),
    countries: ["de"],
    apiKeysPath: sourceKeys,
    now: () => stamp,
    runScript: async (input) => {
      if (input.script === "feed-proxy-vars-to-json")
        writeFileSync(
          join(out, "feed-proxy-vars.json"),
          JSON.stringify({
            "de-demo-0": {
              url: "https://operator.example/realtime.pb",
              ...(!publicSource ? { headers: { "X-Key": sourceKey } } : {}),
            },
          }),
          { mode: 0o644 },
        );
    },
  });
  ctx.state.catalogDir = catalog;
  ctx.state.catalogPins = pair;
  expect((await generate(ctx)).status).toBe("ok");
  const assembled = await assemble(ctx);
  expect(assembled.status).toBe("ok");
  expect(assembled.artifacts?.portableRecipeWritten).toBe(true);
  const stagingDir = join(root, "prepared-motis-live");
  mkdirSync(stagingDir, { mode: 0o755 });
  for (const name of [
    "license.json",
    "de_demo.gtfs.zip",
    "portable-sources.json",
    ...(actualPinnedTemplate ? ["planet-latest.osm.pbf"] : []),
  ])
    copyFileSync(join(ctx.motisStagingDataDir, name), join(stagingDir, name));
  const configurationRevisionId = `cfg1_${"a".repeat(43)}`,
    generation = join(infraDir, CONFIGURATION_GENERATIONS, configurationRevisionId),
    secretDir = join(generation, ".generated-secrets/data-manager");
  mkdirSync(secretDir, { recursive: true, mode: 0o700 });
  for (const path of [generation, join(generation, ".generated-secrets"), secretDir])
    chmodSync(path, 0o700);
  const secret = join(secretDir, "TRANSITOUS_API_KEYS");
  writeFileSync(secret, JSON.stringify({ "de/demo": destinationKey }), { mode: 0o444 });
  symlinkSync(
    relative(dirname(join(infraDir, CURRENT_CONFIGURATION)), generation),
    join(infraDir, CURRENT_CONFIGURATION),
  );
  return {
    rootDir: root,
    infraDir,
    stagingDir,
    configurationRevisionId,
    dataManagerEnvironment: publicSource
      ? {}
      : { TRANSITOUS_API_KEYS_FILE: "/run/secrets/TRANSITOUS_API_KEYS" },
    secret,
    catalog,
    sourceStaging: ctx.motisStagingDataDir,
  };
}
it("round-trips actual generator/assembly output with destination credentials and no lifecycle/network call", async () => {
  const f = await fixture();
  vi.spyOn(globalThis, "fetch").mockRejectedValue(Error("No network allowed"));
  const preview = await inspectMotisPortableDestination(f);
  expect(preview.requiredCredentials).toEqual(["de/demo"]);
  expect(JSON.stringify(preview)).not.toContain(destinationKey);
  const { manifest } = await materializeMotisPortableDestination({
    ...f,
    archiveFingerprint: "d".repeat(64),
    expectedFingerprint: preview.fingerprint,
  });
  expect(manifest.expectations.realtimeFeeds).toBe(1);
  const proxy = readFileSync(join(f.stagingDir, ".openmapx-feed-proxy/conf/default.conf"), "utf8");
  expect(proxy).toContain(destinationKey);
  expect(proxy).not.toContain(sourceKey);
  expect(globalThis.fetch).not.toHaveBeenCalled();
  expect(existsSync(join(f.stagingDir, "mobility-capabilities.json"))).toBe(false);
}, 30000);
it("supports normal public pinned feeds without requiring a credential owner", async () => {
  const f = await fixture(true),
    preview = await inspectMotisPortableDestination(f);
  expect(preview.requiredCredentials).toEqual([]);
  await materializeMotisPortableDestination({
    ...f,
    archiveFingerprint: "d".repeat(64),
    expectedFingerprint: preview.fingerprint,
  });
}, 30000);
it("uses pinned Git objects even when the catalog working-tree endpoint is replaced", async () => {
  const f = await fixture();
  writeFileSync(
    join(f.catalog, "feeds/de.json"),
    JSON.stringify({
      sources: [{ name: "demo", type: "url", spec: "gtfs-rt", url: "https://attacker.example" }],
    }),
    { mode: 0o644 },
  );
  const preview = await inspectMotisPortableDestination(f);
  await materializeMotisPortableDestination({
    ...f,
    archiveFingerprint: "d".repeat(64),
    expectedFingerprint: preview.fingerprint,
  });
  expect(
    readFileSync(join(f.stagingDir, ".openmapx-feed-proxy/conf/default.conf"), "utf8"),
  ).not.toContain("attacker.example");
}, 30000);
it("conflicts after the destination credential inode changes, even with identical contents", async () => {
  const f = await fixture(),
    preview = await inspectMotisPortableDestination(f),
    bytes = readFileSync(f.secret);
  writeFileSync(`${f.secret}.next`, bytes, { mode: 0o444 });
  renameSync(`${f.secret}.next`, f.secret);
  await expect(
    materializeMotisPortableDestination({
      ...f,
      archiveFingerprint: "d".repeat(64),
      expectedFingerprint: preview.fingerprint,
    }),
  ).rejects.toThrow("prerequisites changed");
  expect(existsSync(join(f.stagingDir, "config.yml"))).toBe(false);
}, 30000);
it("reports host-owned and missing target credentials as explicit prerequisites", async () => {
  const f = await fixture();
  await expect(
    inspectMotisPortableDestination({
      ...f,
      dataManagerEnvironment: { TRANSITOUS_API_KEYS_PATH: "/host/private.json" },
    }),
  ).rejects.toThrow("host-owned");
  chmodSync(f.secret, 0o600);
  writeFileSync(f.secret, "{}", { mode: 0o644 });
  chmodSync(f.secret, 0o444);
  await expect(inspectMotisPortableDestination(f)).rejects.toThrow("missing feed credentials");
}, 30000);

it("produces a portable recipe from the actual accepted upstream pinned template and normal public candidate", async () => {
  const f = await fixture(true, true);
  const preview = await inspectMotisPortableDestination(f);
  await materializeMotisPortableDestination({
    ...f,
    archiveFingerprint: "d".repeat(64),
    expectedFingerprint: preview.fingerprint,
  });
  const text = readFileSync(join(f.stagingDir, "config.yml"), "utf8");
  expect(text).toContain("https://transitous.org/sources/");
  expect(text).toContain("/opt/motis/ui/");
}, 30000);

it("imports an actual portable candidate through the production agent with destination-managed credentials and no lifecycle effects", async () => {
  const source = await fixture();
  const { ownedServiceHost } = await import("../__fixtures__/owned-service-host");
  const { Writable } = await import("node:stream");
  const { cpSync } = await import("node:fs");
  const control = await import("@openmapx/core/build-artifacts");
  const { services } = await import("@openmapx/core/server");
  const { OpsClient } = await import("@openmapx/core/ops");
  const { openOpsJobJournal } = await import("../journal");
  const { buildOpsAgentServer } = await import("../server");
  const { ArtifactTransferStore } = await import("./store");
  const { installArtifactTransferRuntime } = await import("./runtime");
  const { installPreparedImportRuntime } = await import("./import-runtime");
  const host = await ownedServiceHost({
    withCoordinator: true,
    actualComposeConfig: true,
    extraServiceIds: ["motis-staging", "motis-feed-proxy"],
    schemas: {
      "data-manager": {
        type: "object",
        properties: { TRANSITOUS_API_KEYS: { type: "string", "x-openmapx-secret": true } },
      },
    },
  });
  roots.push(host.cleanupRoot);
  host.setRows([]);
  await services.commitConfigurationGeneration({
    infraDir: host.infraDir,
    services: host.loaded,
    input: {
      ...services.readAppliedConfiguration(host.infraDir),
      domain: "example.test",
      selectedRoots: ["motis", "data-manager", "motis-staging", "motis-feed-proxy"],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [
        {
          serviceId: "data-manager",
          values: { TRANSITOUS_API_KEYS: JSON.stringify({ "de/demo": destinationKey }) },
        },
      ],
    },
  });
  cpSync(join(source.infraDir, "catalog-pins"), join(host.infraDir, "catalog-pins"), {
    recursive: true,
  });
  cpSync(source.catalog, join(host.infraDir, "data/.transitous-catalog"), {
    recursive: true,
    dereference: false,
  });
  const portable = join(source.rootDir, "export"),
    live = join(portable, "motis/live");
  mkdirSync(join(live, "data"), { mode: 0o755, recursive: true });
  cpSync(source.sourceStaging, live, { recursive: true });
  writeFileSync(join(live, "data/tt.bin"), "synthetic compiled timetable", { mode: 0o644 });
  cpSync(join(source.sourceStaging, ".openmapx-feed-proxy"), join(portable, "motis-feed-proxy"), {
    recursive: true,
  });
  const chunks: Buffer[] = [];
  await control.writeBuildBundle({
    dataRoot: portable,
    serviceId: "motis",
    record: {
      schemaVersion: 1,
      service: "motis",
      builtAt: stamp,
      runtimeImages: { motis: "example/motis:1" },
      toolImages: {},
    },
    target: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    limits: control.DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
    signal: new AbortController().signal,
  });
  const bytes = Buffer.concat(chunks),
    installation = control.openControlInstallation({
      infraDir: host.infraDir,
      role: "ops-agent",
      serviceIds: host.loaded.map((s) => s.manifest.id),
    }),
    store = new ArtifactTransferStore({
      dataRoot: join(host.infraDir, "data/.openmapx-transfers"),
      privateRoot: join(host.infraDir, "control-private/ops-agent/artifact-transfers"),
      token: host.token,
      capacity: () => ({ bytes: 8 * 1024 ** 3, inodes: 100000 }),
    });
  installArtifactTransferRuntime(host.runtime, store);
  installPreparedImportRuntime(host.runtime, store, {
    rootDir: host.root,
    infraDir: host.infraDir,
    stack: host.stack,
    loadAuthority: host.loadAuthority,
    ownedServices: host.owned,
    execFile: host.execFile,
  });
  let originalRuntimeFailure: unknown;
  const originalImport = host.runtime["artifactTransfer.import"];
  host.runtime["artifactTransfer.import"] = async (operation, context) => {
    try {
      return await originalImport(operation, context);
    } catch (error) {
      originalRuntimeFailure = error;
      throw error;
    }
  };
  const app = buildOpsAgentServer({
    runtime: host.runtime,
    journal: await openOpsJobJournal(coreServices.agentStatePaths(host.infraDir).journal),
    resourceClaimer: host.claimer,
    controlInstallation: installation,
    artifactTransfers: store,
    tokens: { api: host.token, "data-manager": "d".repeat(43) },
  });
  const token = join(host.root, "portable-token");
  writeFileSync(token, host.token, { mode: 0o600 });
  const client = new OpsClient({
    baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }),
    tokenFile: token,
  });
  try {
    const stage = await store.createStage({
      ownerId: "portable-admin",
      purpose: "prepared-artifact",
      direction: "upload",
      declaredBytes: bytes.length,
      operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    });
    await store.upload({
      stageId: stage.stageId,
      ownerId: "portable-admin",
      purpose: stage.purpose,
      attemptId: randomUUID(),
      deadlineAt: Date.now() + 60000,
      body: new ReadableStream({
        start(c) {
          c.enqueue(bytes);
          c.close();
        },
      }),
    });
    const run = async (operation: import("@openmapx/core/ops").OpsOperation) => {
      const deadline = Date.now() + 600000,
        admitted = await client.execute(operation, {
          operationKey: createControlRootOperationKey({
            notAfter: deadline,
            nonce: randomBytes(16),
          }),
          execution: { requestedDeadlineAt: deadline },
        });
      if (admitted.execution !== "async") throw Error("Expected queued artifact operation");
      let status = await client.status(operation.kind, admitted.operationId);
      await vi.waitFor(
        async () => {
          status = await client.status(operation.kind, admitted.operationId);
          if (status.state === "failed" && originalRuntimeFailure instanceof Error)
            throw originalRuntimeFailure.cause ?? originalRuntimeFailure;
          expect(
            status.state,
            JSON.stringify({ error: status.errorClass, result: status.result }),
          ).toBe("succeeded");
        },
        { timeout: 30000, interval: 50 },
      );
      return status;
    };
    await run({
      kind: "artifactTransfer.validate",
      stageId: stage.stageId,
      ownerId: "portable-admin",
      purpose: "prepared-artifact",
    });
    const preview = await client.execute({
      kind: "artifactTransfer.previewImport",
      stageId: stage.stageId,
      ownerId: "portable-admin",
    });
    if (preview.execution !== "sync") throw Error("No original preview");
    expect(preview.value.blockers).toEqual([]);
    const result = await run({
      kind: "artifactTransfer.import",
      stageId: stage.stageId,
      ownerId: "portable-admin",
      expectedSha256: preview.value.sha256,
      previewFingerprint: preview.value.fingerprint,
      expectedCurrentRevisionId: preview.value.currentRevisionId,
    });
    expect(result.result).toMatchObject({ outcome: "committed", followUp: "complete" });
    const config = readFileSync(
      join(host.infraDir, "data/motis-feed-proxy/conf/default.conf"),
      "utf8",
    );
    expect(config).toContain(destinationKey);
    expect(config).not.toContain(sourceKey);
    expect(readFileSync(join(host.infraDir, "data/motis/live/data/tt.bin"), "utf8")).toBe(
      "synthetic compiled timetable",
    );
    expect(
      host.calls.some(
        (args) => args.includes("up") || args.includes("stop") || args.includes("pull"),
      ),
    ).toBe(false);
  } finally {
    await app.close();
    store.close();
    control.closeControlInstallation(installation);
  }
}, 90000);
