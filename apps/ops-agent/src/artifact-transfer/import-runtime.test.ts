import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
import { buildOpsAgentServer } from "../server";
import { installPreparedImportRuntime } from "./import-runtime";
import { installArtifactTransferRuntime } from "./runtime";
import { ArtifactTransferStore } from "./store";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
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
