import { randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Writable } from "node:stream";
import {
  closeControlInstallation,
  DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
  openControlInstallation,
  restoreAdmittedControlExecution,
  verifyRetainedArtifactTargetRootRelease,
  writeBuildBundle,
} from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  executionRefSchema,
  OpsClient,
  type OpsOperation,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { afterEach, expect, it, vi } from "vitest";
import { ownedServiceHost } from "../__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../journal";
import { createProductionOpsRuntime, productionOwnedServices } from "../production-runtime";
import { buildOpsAgentServer } from "../server";
import { installPreparedImportRuntime } from "./import-runtime";
import { installArtifactTransferRuntime } from "./runtime";
import { ArtifactTransferStore } from "./store";

vi.mock("node:fs", async (original) => {
  const native = await original<typeof import("node:fs")>();
  return { ...native, renameSync: vi.fn(native.renameSync) };
});
const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.reverse().splice(0)) await close();
});
async function fixture() {
  const host = await ownedServiceHost({ extraServiceIds: ["osrm"] });
  cleanups.push(() => rmSync(host.cleanupRoot, { recursive: true, force: true }));
  const installation = openControlInstallation({
    infraDir: host.infraDir,
    role: "ops-agent",
    serviceIds: host.loaded.map((s) => s.manifest.id),
  });
  cleanups.push(() => closeControlInstallation(installation));
  const store = new ArtifactTransferStore({
    dataRoot: join(host.infraDir, "data/.openmapx-transfers"),
    privateRoot: join(host.infraDir, "control-private/ops-agent/artifact-transfers"),
    token: host.token,
    capacity: () => ({ bytes: 8 * 1024 ** 3, inodes: 100000 }),
  });
  cleanups.push(() => store.close());
  installArtifactTransferRuntime(host.runtime, store);
  installPreparedImportRuntime(host.runtime, store, {
    rootDir: host.root,
    infraDir: host.infraDir,
    stack: host.stack,
    loadAuthority: host.loadAuthority,
    ownedServices: host.owned,
    execFile: host.execFile,
  });
  const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json")),
    app = buildOpsAgentServer({
      runtime: host.runtime,
      journal,
      resourceClaimer: host.claimer,
      controlInstallation: installation,
      artifactTransfers: store,
      tokens: { api: host.token, "data-manager": "d".repeat(43) },
    });
  let lose = false;
  app.addHook("onSend", async (request, reply, payload) => {
    if (
      lose &&
      reply.statusCode === 202 &&
      (request.body as { operation?: { kind?: string } })?.operation?.kind ===
        "artifactTransfer.import"
    ) {
      lose = false;
      reply.code(503);
      return JSON.stringify({ error: "Named lost original import response" });
    }
    return payload;
  });
  const tokenFile = join(host.root, "api-token");
  writeFileSync(tokenFile, host.token, { mode: 0o600 });
  const client = new OpsClient({
    baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }),
    tokenFile,
  });
  cleanups.push(() => app.close());
  const source = join(host.root, "portable-source");
  mkdirSync(join(source, "osrm-graph"), { recursive: true });
  for (const name of [
    "region.osrm",
    "region.osrm.partition",
    "region.osrm.cells",
    "region.osrm.mldgr",
  ])
    writeFileSync(join(source, "osrm-graph", name), `synthetic ${name}`);
  const chunks: Buffer[] = [];
  await writeBuildBundle({
    dataRoot: source,
    serviceId: "osrm",
    record: {
      schemaVersion: 1,
      service: "osrm",
      builtAt: new Date().toISOString(),
      runtimeImages: { osrm: "example/osrm:1" },
      toolImages: {},
    },
    target: new Writable({
      write(chunk, _enc, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    limits: DEFAULT_ARTIFACT_ARCHIVE_LIMITS,
    signal: new AbortController().signal,
  });
  const bytes = Buffer.concat(chunks),
    stage = await store.createStage({
      purpose: "prepared-artifact",
      direction: "upload",
      ownerId: "synthetic-admin",
      declaredBytes: bytes.length,
      operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
    });
  await store.upload({
    stageId: stage.stageId,
    ownerId: "synthetic-admin",
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
  async function run<K extends OpsOperation["kind"]>(
    operation: Extract<OpsOperation, { kind: K }>,
  ) {
    const deadline = Date.now() + 600000,
      operationKey = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
      admitted = await client.execute(operation, {
        operationKey,
        execution: { requestedDeadlineAt: deadline },
      });
    if (admitted.execution !== "async") throw Error("Expected admitted job");
    let status = await client.status(operation.kind, admitted.operationId);
    await vi.waitFor(
      async () => {
        status = await client.status(operation.kind, admitted.operationId);
        expect(
          status.state,
          JSON.stringify({ error: status.errorClass, result: status.result }),
        ).toBe("succeeded");
      },
      { timeout: 30000, interval: 50 },
    );
    return status;
  }
  await run({
    kind: "artifactTransfer.validate",
    stageId: stage.stageId,
    ownerId: "synthetic-admin",
    purpose: "prepared-artifact",
  });
  async function preview() {
    const result = await client.execute({
      kind: "artifactTransfer.previewImport",
      stageId: stage.stageId,
      ownerId: "synthetic-admin",
    });
    if (result.execution !== "sync") throw Error("Expected preview");
    return result.value;
  }
  return {
    ...host,
    app,
    client,
    store,
    journal,
    installation,
    stage,
    preview,
    run,
    loseResponse() {
      lose = true;
    },
  };
}
it("imports through the real registered server and original target root after a lost admission response", async () => {
  const f = await fixture(),
    preview = await f.preview();
  expect(preview.blockers).toEqual([]);
  const operation = {
      kind: "artifactTransfer.import" as const,
      stageId: f.stage.stageId,
      ownerId: "synthetic-admin",
      expectedSha256: preview.sha256,
      previewFingerprint: preview.fingerprint,
      expectedCurrentRevisionId: preview.currentRevisionId,
    },
    deadline = Date.now() + 600000,
    operationKey = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
  f.loseResponse();
  await expect(
    f.client.execute(operation, { operationKey, execution: { requestedDeadlineAt: deadline } }),
  ).rejects.toThrow();
  let status = await f.client.lookup(operation, operationKey, {
    execution: { requestedDeadlineAt: deadline },
  });
  await vi.waitFor(
    async () => {
      status = await f.client.lookup(operation, operationKey, {
        execution: { requestedDeadlineAt: deadline },
      });
      expect(
        status.state,
        JSON.stringify({ error: status.errorClass, result: status.result }),
      ).toBe("succeeded");
    },
    { timeout: 30000, interval: 50 },
  );
  expect(status.result).toMatchObject({
    outcome: "committed",
    serviceId: "osrm",
    followUp: "complete",
  });
  expect(readFileSync(join(f.infraDir, "data/osrm-graph/region.osrm"), "utf8")).toBe(
    "synthetic region.osrm",
  );
  expect(
    (
      await f.store.getStage({
        stageId: f.stage.stageId,
        ownerId: "synthetic-admin",
        purpose: "prepared-artifact",
      })
    ).state,
  ).toBe("consumed");
  expect(
    f.journal.records().filter((j) => j.operation.kind === "artifactTransfer.import"),
  ).toHaveLength(1);
  const execution = executionRefSchema.parse({
    executor: "ops-agent" as const,
    principal: "api" as const,
    executionId: status.operationId,
    operationKey: status.operationKey,
    operationFingerprint: opsOperationFingerprint(operation),
    fingerprint: status.fingerprint,
    deadlineAt: status.deadlineAt,
  });
  verifyRetainedArtifactTargetRootRelease(
    restoreAdmittedControlExecution(f.installation, execution),
  );
  expect(
    f.calls.some((args) => args.includes("up") || args.includes("stop") || args.includes("pull")),
  ).toBe(false);
}, 60000);
it("blocks a live consumer and refuses a changed configuration after preview without publishing", async () => {
  const f = await fixture(),
    preview = await f.preview();
  f.setRows([
    {
      ...f.row,
      Labels: { ...f.row.Labels, "com.docker.compose.service": "osrm" },
      ConfigImage: "example/osrm:1",
    },
  ]);
  expect((await f.preview()).runningConsumers).toContain("osrm");
  f.setRows([f.row]);
  const before = services.currentConfigurationGeneration(f.infraDir);
  await services.commitConfigurationGeneration({
    infraDir: f.infraDir,
    services: f.loaded,
    input: {
      ...services.readAppliedConfiguration(f.infraDir),
      selectedRoots: ["motis", "osrm"],
      domain: "changed.example.test",
    },
  });
  expect(services.currentConfigurationGeneration(f.infraDir)).not.toBe(before);
  await expect(
    f.client.execute(
      {
        kind: "artifactTransfer.import",
        stageId: f.stage.stageId,
        ownerId: "synthetic-admin",
        expectedSha256: preview.sha256,
        previewFingerprint: preview.fingerprint,
        expectedCurrentRevisionId: preview.currentRevisionId,
      },
      {
        operationKey: createControlRootOperationKey({
          notAfter: Date.now() + 600000,
          nonce: randomBytes(16),
        }),
        execution: { requestedDeadlineAt: Date.now() + 600000 },
      },
    ),
  ).rejects.toThrow();
  expect(f.calls.some((args) => args.includes("up") || args.includes("stop"))).toBe(false);
}, 60000);

it("reconciles the original prepared publication after exact foreign-inode repair and server reassembly", async () => {
  const f = await fixture(),
    old = join(f.infraDir, "data/osrm-graph");
  mkdirSync(old);
  writeFileSync(join(old, "old"), "old graph");
  const oldInode = fs.statSync(old).ino;
  const preview = await f.preview(),
    operation = {
      kind: "artifactTransfer.import" as const,
      stageId: f.stage.stageId,
      ownerId: "synthetic-admin",
      expectedSha256: preview.sha256,
      previewFingerprint: preview.fingerprint,
      expectedCurrentRevisionId: preview.currentRevisionId,
    };
  const stage = join(f.infraDir, "data/.openmapx-transfers", f.stage.stageId),
    prepared = fs.readdirSync(stage).find((name) => name.startsWith("prepared-"));
  if (!prepared) throw Error("No original prepared source");
  const newInode = fs.statSync(join(stage, prepared, "osrm-graph")).ino,
    native = await vi.importActual<typeof import("node:fs")>("node:fs");
  let replaced = false;
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (
      !replaced &&
      native.statSync(from).isDirectory() &&
      native.statSync(from).ino === newInode
    ) {
      replaced = true;
      native.mkdirSync(to);
      throw Error("Named foreign live-directory replacement");
    }
    return native.renameSync(from, to);
  });
  const deadline = Date.now() + 600000,
    key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
    admitted = await f.client.execute(operation, {
      operationKey: key,
      execution: { requestedDeadlineAt: deadline },
    });
  if (admitted.execution !== "async") throw Error("No original import");
  let status = await f.client.status("artifactTransfer.import", admitted.operationId);
  await vi.waitFor(
    async () => {
      status = await f.client.status("artifactTransfer.import", admitted.operationId);
      expect(status.state).toBe("failed");
      expect(status.errorClass).toBe("recovery_required");
    },
    { timeout: 20000, interval: 50 },
  );
  expect(replaced).toBe(true);
  expect(
    (
      await f.store.getStage({
        stageId: f.stage.stageId,
        ownerId: "synthetic-admin",
        purpose: "prepared-artifact",
      })
    ).state,
  ).toBe("claimed");
  await f.app.close();
  vi.mocked(fs.renameSync).mockImplementation(native.renameSync);
  // Only this test's explicitly created empty foreign node is repaired. The
  // production recovery consumer must never overwrite an unexplained inode.
  native.rmdirSync(old);
  const installation = openControlInstallation({
    infraDir: f.infraDir,
    role: "ops-agent",
    serviceIds: f.loaded.map((s) => s.manifest.id),
  });
  cleanups.push(() => closeControlInstallation(installation));
  const runtime = await createProductionOpsRuntime({
    rootDir: f.root,
    stack: f.stack,
    loadAuthority: f.loadAuthority,
    communityRepositories: f.repositories,
    docker: { execFile: f.execFile, fileExists: existsSync },
  });
  const store = new ArtifactTransferStore({
    dataRoot: join(f.infraDir, "data/.openmapx-transfers"),
    privateRoot: join(f.infraDir, "control-private/ops-agent/artifact-transfers"),
    token: f.token,
    capacity: () => ({ bytes: 8 * 1024 ** 3, inodes: 100000 }),
  });
  cleanups.push(() => store.close());
  installArtifactTransferRuntime(runtime, store);
  installPreparedImportRuntime(runtime, store, {
    rootDir: f.root,
    infraDir: f.infraDir,
    stack: f.stack,
    loadAuthority: f.loadAuthority,
    ownedServices: productionOwnedServices(runtime),
    execFile: f.execFile,
  });
  const journal = await openOpsJobJournal(join(f.infraDir, "data/ops-agent/jobs-v1.json")),
    app = buildOpsAgentServer({
      runtime,
      journal,
      resourceClaimer: f.createResourceClaimer(runtime),
      controlInstallation: installation,
      artifactTransfers: store,
      tokens: { api: f.token, "data-manager": "d".repeat(43) },
    });
  cleanups.push(() => app.close());
  const freshClient = new OpsClient({
    baseUrl: await app.listen({ host: "127.0.0.1", port: 0 }),
    tokenFile: join(f.root, "api-token"),
  });
  expect(
    (
      await store.getStage({
        stageId: f.stage.stageId,
        ownerId: "synthetic-admin",
        purpose: "prepared-artifact",
      })
    ).state,
  ).toBe("ready");
  expect(fs.statSync(old).ino).toBe(oldInode);
  expect(readFileSync(join(old, "old"), "utf8")).toBe("old graph");
  const execution = executionRefSchema.parse({
    executor: "ops-agent",
    principal: "api",
    executionId: status.operationId,
    operationKey: status.operationKey,
    operationFingerprint: opsOperationFingerprint(operation),
    fingerprint: status.fingerprint,
    deadlineAt: status.deadlineAt,
  });
  verifyRetainedArtifactTargetRootRelease(restoreAdmittedControlExecution(installation, execution));
  expect(
    journal.records().filter((job) => job.operation.kind === "artifactTransfer.import"),
  ).toHaveLength(1);
  const nextPreview = await freshClient.execute({
    kind: "artifactTransfer.previewImport",
    stageId: f.stage.stageId,
    ownerId: "synthetic-admin",
  });
  if (nextPreview.execution !== "sync") throw Error("No next preview");
  expect(nextPreview.value.blockers).toEqual([]);
  const nextDeadline = Date.now() + 600000,
    next = await freshClient.execute(
      {
        kind: "artifactTransfer.import",
        stageId: f.stage.stageId,
        ownerId: "synthetic-admin",
        expectedSha256: nextPreview.value.sha256,
        previewFingerprint: nextPreview.value.fingerprint,
        expectedCurrentRevisionId: nextPreview.value.currentRevisionId,
      },
      {
        operationKey: createControlRootOperationKey({
          notAfter: nextDeadline,
          nonce: randomBytes(16),
        }),
        execution: { requestedDeadlineAt: nextDeadline },
      },
    );
  if (next.execution !== "async") throw Error("No explicit new import");
  await vi.waitFor(
    async () => {
      const value = await freshClient.status("artifactTransfer.import", next.operationId);
      expect(value.state, JSON.stringify({ error: value.errorClass, result: value.result })).toBe(
        "succeeded",
      );
      expect(value.result).toMatchObject({ outcome: "committed", followUp: "complete" });
    },
    { timeout: 20000, interval: 50 },
  );
  expect(
    (
      await store.getStage({
        stageId: f.stage.stageId,
        ownerId: "synthetic-admin",
        purpose: "prepared-artifact",
      })
    ).state,
  ).toBe("consumed");
  expect(
    journal.records().filter((job) => job.operation.kind === "artifactTransfer.import"),
  ).toHaveLength(2);
  expect(
    f.calls.some((args) => args.includes("up") || args.includes("stop") || args.includes("pull")),
  ).toBe(false);
}, 60000);
