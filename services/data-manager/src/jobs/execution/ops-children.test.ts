import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import * as control from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  OpsClient,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { applyHardlinkPlan } from "@openmapx/hardlinks";
import { build } from "esbuild";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { transitChildCandidateId } from "./ops-children.js";

let bundle: string, bundleRoot: string;
beforeAll(async () => {
  bundleRoot = mkdtempSync(join(tmpdir(), "omx-data-agent-bundle-"));
  bundle = join(bundleRoot, "agent.mjs");
  await build({
    entryPoints: [resolve("apps/ops-agent/src/test-fixtures/data-owned-http-process.ts")],
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    outfile: bundle,
    banner: {
      js: `import {createRequire} from "node:module"; const require=createRequire(${JSON.stringify(resolve("apps/ops-agent/package.json"))});`,
    },
  });
});
afterAll(() => {
  if (bundleRoot) rmSync(bundleRoot, { recursive: true, force: true });
});
it.each(["promotion", "reload"] as const)(
  "keeps actual separate-process agent %s fenced across lost admission and cancellation responses",
  async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "omx-data-http-cancel-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["motis", "motis-feed-proxy"],
    });
    const agentVerifier = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis", "motis-feed-proxy"],
    });
    const executionId = randomUUID(),
      deadlineAt = Date.now() + 60000,
      operationKey = createControlRootOperationKey({
        notAfter: deadlineAt,
        nonce: randomBytes(16),
      });
    const operation =
      kind === "promotion"
        ? { kind: "motis.primary.promote" as const, preparedRunId: executionId }
        : {
            kind: "feedProxy.validateAndReload" as const,
            candidateId: transitChildCandidateId({ operationKey }, "proxy-stage", 0),
          };
    const phase = kind === "promotion" ? ("promote-primary" as const) : ("proxy-stage" as const);
    const serviceIds = kind === "promotion" ? ["motis"] : ["motis-feed-proxy"];
    const input = { kind: "transit-sync", countries: ["de"] };
    const operationFingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const owner: ExecutionRef = {
      executor: "data-manager",
      principal: "data-manager",
      executionId,
      operationKey,
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: input.kind, operationFingerprint, deadlineAt }),
    };
    const child: ExecutionRef = {
      executor: "ops-agent",
      principal: "data-manager",
      executionId: `job1_${randomUUID().replaceAll("-", "")}`,
      operationKey: control.controlChildOperationKey(owner.operationKey, phase, 0),
      operationFingerprint: opsOperationFingerprint(operation),
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: operation.kind,
        operationFingerprint: opsOperationFingerprint(operation),
        deadlineAt,
        parent: control.retainedControlParent(owner),
      }),
    };
    const plan = {
      phase,
      ordinal: 0,
      kind: operation.kind,
      execution: child,
      serviceIds,
      recipient: "ops-agent" as const,
    };
    const authority = control.retainAdmittedControlExecution(dm, {
      execution: owner,
      kind: input.kind,
      operation: input,
      admittedAt: deadlineAt - 60000,
      requestedDeadlineAt: deadlineAt,
      serviceIds,
      plan: [plan],
    });
    const lease = await control.acquireArtifactTargetLease({
      dataRoot: join(root, "data"),
      serviceIds,
      owner: authority,
    });
    if (kind === "promotion") {
      writePreparedFixture(join(root, "data/motis/staging"), executionId);
      control.retainOwnedDataTransitCandidate(authority, { phase, ordinal: 0 });
      renameSync(join(root, "data/motis/staging"), join(root, "data/motis/live"));
    } else {
      mkdirSync(join(root, "data/motis-feed-proxy/conf"), { mode: 0o700, recursive: true });
      writeFileSync(
        join(root, "data/motis-feed-proxy/conf/default.conf"),
        "server { listen 80; }\n",
        { mode: 0o600 },
      );
      writeFileSync(join(root, "data/motis-feed-proxy/feed-proxy-vars.json"), "{}\n", {
        mode: 0o600,
      });
      linkProxyFixture(join(root, "data"));
      control.retainOwnedDataTransitCandidate(authority, { phase, ordinal: 0 });
    }
    const assertion = await control.delegateArtifactTargetLease(lease, {
      ...plan,
      childPublicKey: agentVerifier.publicKey,
    });
    const token = "b".repeat(43),
      tokenFile = join(root, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const process = spawn(globalThis.process.execPath, [bundle], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stderr = "";
    process.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const lines = createInterface({ input: process.stdout });
    const iterator = lines[Symbol.asyncIterator]();
    const next = async () => {
      const value = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(
            () => reject(Error(`Agent process did not respond: ${stderr}`)),
            8000,
          );
          timer.unref();
        }),
      ]);
      if (value.done) throw Error(`Agent process exited: ${stderr}`);
      return JSON.parse(value.value) as Record<string, unknown>;
    };
    const send = (value: unknown) => process.stdin.write(`${JSON.stringify(value)}\n`);
    const exited = new Promise<void>((done) => process.once("close", () => done()));
    send({ root, token });
    try {
      const ready = await next();
      expect(ready.type).toBe("ready");
      let admissions = 0,
        cancels = 0;
      const client = new OpsClient({
        baseUrl: `http://127.0.0.1:${ready.port}`,
        tokenFile,
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (options?.method === "POST") {
            admissions++;
            await response.body?.cancel();
            throw Error("synthetic lost admission response");
          }
          if (options?.method === "DELETE") {
            cancels++;
            await response.body?.cancel();
            throw Error("synthetic lost cancel response");
          }
          return response;
        },
      });
      await expect(
        client.execute(operation, {
          operationKey: child.operationKey,
          execution: { requestedDeadlineAt: deadlineAt },
          controlAssertion: assertion,
        }),
      ).rejects.toThrow();
      expect((await next()).type).toBe("effect");
      const adopted = await client.lookup(operation, child.operationKey, {
        fingerprint: child.fingerprint,
        execution: { requestedDeadlineAt: deadlineAt },
      });
      expect(adopted.operationId).toBe(child.executionId);
      const cancellation = client
        .cancel(child.executionId, { fingerprint: child.fingerprint })
        .then(
          () => null,
          (error) => error,
        );
      expect((await next()).type).toBe("aborted");
      send({ type: "probe" });
      const probe = await next();
      expect(probe).toMatchObject({
        type: "probe",
        forward: false,
        effects: 1,
        state: "termination_pending",
        terminalAt: null,
        operationId: child.executionId,
      });
      expect((await client.status(operation.kind, child.executionId)).state).toBe(
        "termination_pending",
      );
      await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
      send({ type: "release" });
      expect(await cancellation).toBeInstanceOf(Error);
      await expect
        .poll(async () => (await client.status(operation.kind, child.executionId)).state)
        .toBe("succeeded");
      expect(admissions).toBe(1);
      expect(cancels).toBe(1);
      expect(
        (await client.lookup(operation, child.operationKey, { fingerprint: child.fingerprint }))
          .operationId,
      ).toBe(child.executionId);
      send({ type: "close" });
      process.stdin.end();
      await exited;
    } finally {
      process.kill("SIGKILL");
      await exited;
      lines.close();
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agentVerifier);
      control.closeControlInstallation(dm);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);

import { existsSync } from "node:fs";
import {
  cancelDataExecution,
  createDataManagerTransport,
  getDataExecution,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import Fastify from "fastify";
import postgres from "postgres";
import { registerApi } from "../../api.js";
import { registerAuth } from "../../auth.js";
import { resetOpsClient } from "../../ops-client.js";
import { StateStore } from "../../state.js";
import { resolveOperationsProfile } from "../transitous/operations-profile.js";
import { getSingleFlightController } from "../transitous/runtime.js";
import { createDataConfigurationMaintenance } from "./configuration-maintenance.js";
import { createDataExecutionDispatcher } from "./dispatch.js";
import { createDataExecutionReceiver } from "./receiver.js";
import { createDataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore } from "./store.js";

it.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)(
  "assembles durable DM SQL/runtime/dispatcher/HTTP cancellation through the separate production agent",
  async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");

    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-durable-dm-agent-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
    });
    const journal = control.createDataExecutionControlJournal(dm, sql),
      fence = createDataConfigurationMaintenance(sql, dm);
    await fence.startup();
    const store = createPostgresDataExecutionStore(sql, {
        controlJournal: journal,
        configurationFence: fence,
      }),
      singleFlight = getSingleFlightController(),
      operationsPolicy = resolveOperationsProfile({ countries: ["de"] });
    const dispatcher = createDataExecutionDispatcher({
      dataDir: join(root, "data"),
      state: new StateStore(join(root, "data")),
      sql,
      singleFlight,
      operationsPolicy,
      runHardlinks: async () => {
        throw Error("This fixture has no generation grant");
      },
    });
    const runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch }),
      receiver = createDataExecutionReceiver({
        runtime,
        installation: dm,
        configurationFence: fence,
        dispatcher,
        operationsPolicy,
      });
    const token = "c".repeat(43),
      tokenFile = join(root, "agent-token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const agent = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] }),
      lines = createInterface({ input: agent.stdout }),
      messages = lines[Symbol.asyncIterator]();
    let stderr = "";
    agent.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const next = async () => {
      const result = await Promise.race([
        messages.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(Error(`Agent IPC timeout: ${stderr}`)), 15000);
          timer.unref();
        }),
      ]);
      if (result.done) throw Error(`Agent exited: ${stderr}`);
      return JSON.parse(result.value) as Record<string, unknown>;
    };
    const send = (value: unknown) => agent.stdin.write(`${JSON.stringify(value)}\n`),
      exited = new Promise<void>((resolve) => agent.once("close", () => resolve()));
    send({ root, token });
    const ready = await next();
    let posts = 0,
      cancels = 0;
    resetOpsClient(
      new OpsClient({
        baseUrl: `http://127.0.0.1:${ready.port}`,
        tokenFile,
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (options?.method === "POST") {
            posts++;
            await response.body?.cancel();
            throw Error("Synthetic lost actual agent admission response");
          }
          if (options?.method === "DELETE") {
            cancels++;
            await response.body?.cancel();
            throw Error("Synthetic lost actual agent cancellation response");
          }
          return response;
        },
      }),
    );
    const app = Fastify();
    registerAuth(app, "synthetic-dm-token", { executionReceiver: () => receiver });
    registerApi(app, {
      dataDir: join(root, "data"),
      singleFlight,
      operationsPolicy,
      executionReceiver: receiver,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("DM HTTP address missing");
    const baseUrl = `http://127.0.0.1:${address.port}`,
      transport = createDataManagerTransport({ baseUrl, authToken: "synthetic-dm-token" });
    let id: string | undefined;

    try {
      const observer = new AbortController();
      const observation = fetch(`${baseUrl}/transit/restart-motis`, {
        method: "POST",
        headers: { authorization: "Bearer synthetic-dm-token" },
        signal: observer.signal,
      }).catch((error) => error);
      expect(
        (
          await Promise.race([
            next(),
            observation.then(async (value) => {
              if (value instanceof Response)
                throw Error(`Early DM HTTP ${value.status}: ${await value.text()}`);
              throw value;
            }),
          ])
        ).type,
      ).toBe("effect");
      observer.abort();
      await observation;

      const owned = (await store.listUnsettled()).find(
        (record) => record.input.kind === "transit-maintenance",
      );
      if (!owned) throw Error("Missing actual retained DM root");
      id = owned.status.id;
      const before = unwrapDataManagerResponse(await getDataExecution(id, { transport }));
      expect(before.status).toBe("running");
      expect(owned.finishedAt).toBeNull();
      const losingTransport = createDataManagerTransport({
        baseUrl,
        authToken: "synthetic-dm-token",
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (options?.method === "POST") {
            await response.body?.cancel();
            throw Error("Synthetic lost actual DM cancellation response");
          }
          return response;
        },
      });
      await expect(
        cancelDataExecution(
          id,
          { operationKey: before.operationKey, fingerprint: before.fingerprint },
          { transport: losingTransport },
        ),
      ).rejects.toThrow();

      expect((await next()).type).toBe("aborted");
      const pending = await store.inspect(id);
      expect(pending?.status.status).toBe("cancel_pending");
      expect(pending?.finishedAt).toBeNull();
      expect(existsSync(join(root, "data/.admin-target-control/locks/motis"))).toBe(true);
      send({ type: "probe" });
      expect(await next()).toMatchObject({
        forward: false,
        effects: 1,
        state: "termination_pending",
        terminalAt: null,
      });
      send({ type: "release" });
      await expect
        .poll(async () => (await runtime.inspect(id!))?.status, { timeout: 15000 })
        .toBe("ok");
      expect((await runtime.inspect(id))?.result).toEqual({
        kind: "transit-maintenance",
        action: "restart-primary",
        changed: true,
      });
      await expect
        .poll(() => existsSync(join(root, "data/.admin-target-control/locks/motis")), {
          timeout: 10000,
        })
        .toBe(false);
      expect(posts).toBe(1);
      expect(cancels).toBe(1);
      expect((await store.inspect(id))?.children).toMatchObject([
        { state: "terminal", publication: "committed", dispatchState: "claimed" },
      ]);
    } finally {
      send({ type: "release" });
      await runtime.close();
      app.server.closeAllConnections();
      await app.close();
      send({ type: "close" });
      agent.stdin.end();
      await exited;
      resetOpsClient();
      const fixtureRows = await store.listUnsettled();
      const ownIds = new Set([
        ...(id ? [id] : []),
        ...fixtureRows
          .filter((row) =>
            existsSync(
              join(
                root,
                "control-private/data-manager/executions",
                `${row.status.operationKey}.json`,
              ),
            ),
          )
          .map((row) => row.status.id),
      ]);
      for (const ownId of ownIds) await sql`DELETE FROM data_manager.jobs WHERE id=${ownId}`;
      journal.close();
      control.closeControlInstallation(dm);
      await sql.end();
      lines.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);

import { readFileSync, renameSync, statSync } from "node:fs";
import { startDataExecution } from "@openmapx/core/data-manager-sdk";
import { drizzle } from "drizzle-orm/postgres-js";
import { createCandidateManifest } from "../transitous/candidate.js";
import { retainTransitPhaseCandidate, runTransitOwnedPhase } from "../transitous/owned-ops.js";
import { buildJobContext } from "../transitous/pipeline.js";
import { run as stageProxy } from "../transitous/proxy-transaction.js";
import { publishDataChange } from "./worker-scope.js";

it
  .skipIf(
    !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
      process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
  )
  .each([
    "promotion",
    "reload",
    "validation-failure",
    "restore-validation-failure",
    "cancel-before-restore",
    "expire-before-restore",
    "restore-reservation-crash",
    "restore-files-crash",
  ] as const)(
  "runs an hours-late owned %s through the real DM receiver/store/runtime and separate assembled agent",
  async (kind) => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 });
    drizzle(sql);
    const root = mkdtempSync(join(tmpdir(), "omx-late-durable-child-")),
      data = join(root, "data");
    mkdirSync(data, { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const services = ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
      dm = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: services,
      }),
      journal = control.createDataExecutionControlJournal(dm, sql),
      fence = createDataConfigurationMaintenance(sql, dm);
    await fence.startup();
    const originalAdmittedAt = Date.now() - 4 * 3600000,
      deadline = originalAdmittedAt + 24 * 3600000;
    let storeNow = originalAdmittedAt;
    const store = createPostgresDataExecutionStore(sql, {
      controlJournal: journal,
      configurationFence: fence,
      now: () => storeNow,
    });
    const phase = kind === "promotion" ? ("promote-primary" as const) : ("proxy-stage" as const),
      state = new StateStore(data),
      runtime = createDataExecutionRuntime({
        store,
        dispatch: async (_input, context) => {
          const job = buildJobContext({
            dataDir: data,
            store: state,
            countries: ["de"],
            jobId: context.execution.executionId,
            executionContext: context,
            abortSignal: context.signal,
          });
          let finalStatus: "ok" | "error" = "ok";
          if (kind === "promotion") {
            mkdirSync(join(data, "motis/staging"), { mode: 0o700, recursive: true });
            writePreparedFixture(join(data, "motis/staging"), context.execution.executionId);
            await retainTransitPhaseCandidate(job, phase);
            await publishDataChange(() =>
              renameSync(join(data, "motis/staging"), join(data, "motis/live")),
            );
          } else {
            mkdirSync(join(data, "motis-feed-proxy/conf"), { mode: 0o700, recursive: true });
            writeFileSync(
              join(data, "motis-feed-proxy/conf/default.conf"),
              "server { listen 80; }\n",
              { mode: 0o600 },
            );
            writeFileSync(join(data, "motis-feed-proxy/feed-proxy-vars.json"), "{}\n", {
              mode: 0o600,
            });
            linkProxyFixture(data);
            writePreparedFixture(job.motisStagingDataDir, context.execution.executionId);
            const staged = await stageProxy(job);
            if (staged.status !== "ok") finalStatus = "error";
          }
          if (kind === "promotion") await runTransitOwnedPhase(job, phase);
          context.signal.throwIfAborted();
          return {
            kind: "transit-sync",
            finalStatus,
            sourceRevision: "public-fixture",
            countries: ["de"],
          };
        },
      }),
      singleFlight = getSingleFlightController(),
      operationsPolicy = resolveOperationsProfile({ countries: ["de"] }),
      dispatcher = createDataExecutionDispatcher({
        dataDir: data,
        state,
        sql,
        singleFlight,
        operationsPolicy,
        runHardlinks: async () => {
          throw Error("No generation grant");
        },
      }),
      receiver = createDataExecutionReceiver({
        runtime,
        installation: dm,
        configurationFence: fence,
        dispatcher,
        operationsPolicy,
      });
    let restoreFault: ReturnType<typeof vi.spyOn> | undefined,
      recoveryFaultReached = false;
    const retainRecovery = journal.retainProxyRecoveryIntent.bind(journal);
    journal.retainProxyRecoveryIntent = async (authority, backupDigest) => {
      await retainRecovery(authority, backupDigest);
      if (kind === "cancel-before-restore")
        await runtime.requestCancel({
          id: authority.execution.executionId,
          operationKey: authority.execution.operationKey,
          fingerprint: authority.execution.fingerprint,
        });
      if (kind === "expire-before-restore")
        restoreFault = vi.spyOn(Date, "now").mockReturnValue(deadline + 1);
      recoveryFaultReached = true;
      if (kind === "restore-reservation-crash")
        throw Error("Synthetic crash after confirmed restore reservation");
    };
    const checkpointChild = store.checkpointChild.bind(store);
    store.checkpointChild = async (id, version, child) => {
      const saved = await checkpointChild(id, version, child);
      if (
        saved &&
        child.phase === "proxy-restore" &&
        child.state === "bound" &&
        kind === "restore-files-crash"
      )
        throw Error(
          "Synthetic response loss after files and confirmed binding, before validation dispatch",
        );
      return saved;
    };
    const token = "c".repeat(43),
      tokenFile = join(root, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const agent = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] }),
      lines = createInterface({ input: agent.stdout }),
      messages = lines[Symbol.asyncIterator]();
    let stderr = "";
    agent.stderr.on("data", (chunk) => (stderr += String(chunk)));
    const next = async () => {
        const result = await Promise.race([
          messages.next(),
          new Promise<never>((_, reject) => {
            const timeout = setTimeout(
              () => reject(Error(`Agent fixture IPC timeout: ${stderr}`)),
              15000,
            );
            timeout.unref();
          }),
        ]);
        if (result.done) throw Error(`Agent exited: ${stderr}`);
        return JSON.parse(result.value) as Record<string, unknown>;
      },
      send = (value: unknown) => agent.stdin.write(`${JSON.stringify(value)}\n`),
      exited = new Promise<void>((resolve) => agent.once("close", () => resolve()));
    send({
      root,
      token,
      validationFailure:
        kind === "restore-validation-failure" ? "twice" : !["promotion", "reload"].includes(kind),
    });
    const ready = await next();
    let posts = 0,
      cancels = 0;
    resetOpsClient(
      new OpsClient({
        baseUrl: `http://127.0.0.1:${ready.port}`,
        tokenFile,
        fetch: async (url, options) => {
          const response = await fetch(url, options);
          if (options?.method === "POST") {
            posts++;
            await response.body?.cancel();
            throw Error("Lost real child admission response");
          }
          if (options?.method === "DELETE") {
            cancels++;
            await response.body?.cancel();
            throw Error("Lost real child cancel response");
          }
          return response;
        },
      }),
    );
    const app = Fastify();
    registerAuth(app, "late-fixture-token", { executionReceiver: () => receiver });
    registerApi(app, {
      dataDir: data,
      singleFlight,
      operationsPolicy,
      executionReceiver: receiver,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("DM endpoint missing");
    const transport = createDataManagerTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authToken: "late-fixture-token",
    });
    let id: string | undefined;
    let closingRuntime: Promise<void> | undefined;
    const closeRuntime = () => (closingRuntime ??= runtime.close());
    try {
      const key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        admitted = unwrapDataManagerResponse(
          await startDataExecution(
            {
              operationKey: key,
              requestedDeadlineAt: deadline,
              input: { kind: "transit-sync", countries: ["de"] },
            },
            { transport },
          ),
        );
      id = admitted.id;
      storeNow = Date.now();
      expect(admitted.admittedAt).toBe(originalAdmittedAt);
      if (
        !["promotion", "reload", "validation-failure", "restore-validation-failure"].includes(kind)
      ) {
        expect((await next()).type).toBe("validation-failed");
        send({ type: "release" });
        await expect
          .poll(
            async () =>
              (await store.inspect(id!))?.children.some((child) => child.phase === "proxy-restore"),
            { timeout: 15000 },
          )
          .toBe(true);
        await expect.poll(() => recoveryFaultReached, { timeout: 15000 }).toBe(true);
        if (kind === "restore-files-crash")
          await expect
            .poll(
              async () =>
                (await store.inspect(id!))?.children.find(
                  (child) => child.phase === "proxy-restore",
                )?.state,
              { timeout: 15000 },
            )
            .toBe("bound");
        const lock = join(data, ".admin-target-control/locks/motis-feed-proxy"),
          inode = statSync(lock).ino;
        await expect(
          journal.assertOwnedProxyRecoverySettled((await store.inspect(id))!.execution),
        ).rejects.toThrow();
        expect((await store.inspect(id))?.finishedAt).toBeNull();
        expect(posts).toBe(1);
        restoreFault?.mockRestore();
        restoreFault = undefined;
        await closeRuntime();
        const restarted = createDataExecutionRuntime({
          store,
          dispatch: async () => {
            throw Error("Restart cannot repeat an unfinished restore");
          },
        });
        await restarted.reconcile();
        expect((await store.inspect(id))?.finishedAt).toBeNull();
        expect((await store.inspect(id))?.status.publication).toBe("unknown");
        expect(statSync(lock).ino).toBe(inode);
        expect(posts).toBe(1);
        await restarted.close();
        return;
      }
      if (kind === "validation-failure" || kind === "restore-validation-failure") {
        expect((await next()).type).toBe("validation-failed");
        send({ type: "release" });
        if (kind === "restore-validation-failure") {
          expect((await next()).type).toBe("validation-failed");
          await expect
            .poll(
              async () =>
                (await store.inspect(id!))?.children.filter((child) => child.state === "terminal")
                  .length,
              { timeout: 15000 },
            )
            .toBe(2);
          const lock = join(data, ".admin-target-control/locks/motis-feed-proxy"),
            inode = statSync(lock).ino;
          await expect
            .poll(
              () =>
                existsSync(
                  join(root, "control-private/data-manager/observations", `worker-${key}.json`),
                ),
              { timeout: 15000 },
            )
            .toBe(true);
          expect((await store.inspect(id))?.finishedAt).toBeNull();
          expect((await receiver.inspect(id))?.publication).toBe("unknown");
          expect((await store.inspect(id))?.children).toMatchObject([
            {
              phase: "proxy-stage",
              state: "terminal",
              publication: "not_started",
              settlement: { outcome: "contained" },
            },
            {
              phase: "proxy-restore",
              state: "terminal",
              publication: "not_started",
              settlement: { outcome: "contained" },
            },
          ]);
          await closeRuntime();
          // An older/inconsistent terminal SQL row is not release authority.
          await sql`UPDATE data_manager.jobs SET status='error',finished_at=${new Date().toISOString()}::text::timestamptz,execution_state=jsonb_set(execution_state,'{publication}','"committed"'::jsonb) WHERE id=${id}`;
          const restarted = createDataExecutionRuntime({
            store,
            dispatch: async () => {
              throw Error("Restart may not dispatch a restore");
            },
          });
          await restarted.reconcile();
          expect((await store.inspect(id))?.finishedAt).toBeNull();
          expect((await receiver.inspect(id))?.publication).toBe("unknown");
          expect(statSync(lock).ino).toBe(inode);
          await expect(
            journal.assertOwnedProxyRecoverySettled((await store.inspect(id))!.execution),
          ).rejects.toThrow();
          const clock = vi.spyOn(Date, "now").mockReturnValue(deadline + 72 * 3600000 + 1);
          try {
            expect((await control.reconcileControlRetention(dm, { maxFamilies: 1 })).retired).toBe(
              0,
            );
            expect((await store.inspect(id))?.finishedAt).toBeNull();
            expect(statSync(lock).ino).toBe(inode);
          } finally {
            clock.mockRestore();
          }
          await restarted.close();
          expect(posts).toBe(2);
          expect(cancels).toBe(0);
          return;
        }
        await expect
          .poll(async () => (await receiver.inspect(id!))?.status, { timeout: 15000 })
          .toBe("error");
        const failed = await store.inspect(id);
        expect(failed?.children).toMatchObject([
          {
            phase: "proxy-stage",
            state: "terminal",
            publication: "not_started",
            settlement: { outcome: "contained" },
          },
          { phase: "proxy-restore", state: "terminal", publication: "committed" },
        ]);
        expect(posts).toBe(2);
        expect(cancels).toBe(0);
        return;
      }
      expect((await next()).type).toBe("effect");
      const record = await store.inspect(id);
      if (!record) throw Error("Original data root missing");
      const attempted = record.children[0];
      if (!attempted || attempted.state === "reserved") throw Error("Actual bound child missing");
      expect(attempted.execution.deadlineAt).toBeGreaterThan(Date.now());
      expect(attempted.execution.deadlineAt - Date.now()).toBeLessThanOrEqual(
        kind === "promotion" ? 600000 : 120000,
      );
      expect(record.status.deadlineAt).toBe(deadline);
      const lock = join(
          data,
          ".admin-target-control/locks",
          kind === "promotion" ? "motis" : "motis-feed-proxy",
        ),
        inode = statSync(lock).ino,
        rootReceipt = join(root, "control-private/data-manager/executions", `${key}.json`),
        original = readFileSync(rootReceipt);
      await receiver.requestCancel({ id, operationKey: key, fingerprint: admitted.fingerprint });
      expect((await next()).type).toBe("aborted");
      expect((await store.inspect(id))?.finishedAt).toBeNull();
      expect(statSync(lock).ino).toBe(inode);
      expect((await receiver.inspect(id))?.status).toBe("cancel_pending");
      send({ type: "probe" });
      expect(await next()).toMatchObject({
        forward: false,
        effects: 1,
        state: "termination_pending",
        terminalAt: null,
      });
      send({ type: "release" });
      await expect
        .poll(async () => (await receiver.inspect(id!))?.status, { timeout: 15000 })
        .toBe("canceled");
      expect((await receiver.inspect(id))?.publication).toBe("committed");
      await expect.poll(() => existsSync(lock), { timeout: 10000 }).toBe(false);
      expect(readFileSync(rootReceipt)).toEqual(original);
      expect(posts).toBe(1);
      expect(cancels).toBe(1);
      expect((await store.inspect(id))?.children).toMatchObject([
        { phase, state: "terminal", publication: "committed" },
      ]);
    } finally {
      restoreFault?.mockRestore();
      send({ type: "release" });
      await closeRuntime();
      app.server.closeAllConnections();
      await app.close();
      send({ type: "close" });
      agent.stdin.end();
      await exited;
      resetOpsClient();
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      journal.close();
      control.closeControlInstallation(dm);
      await sql.end();
      lines.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  120000,
);

function writePreparedFixture(staging: string, executionId: string) {
  mkdirSync(staging, { mode: 0o700, recursive: true });
  mkdirSync(join(staging, ".openmapx-feed-proxy/conf"), { mode: 0o700, recursive: true });
  for (const [name, body] of [
    ["config.yml", "timetable:\n  datasets:\n    public: test.gtfs.zip\n"],
    ["license.json", "{}"],
    [".openmapx-feed-proxy/conf/default.conf", "server { listen 80; }"],
    [".openmapx-feed-proxy/feed-proxy-vars.json", "{}"],
    [
      "transit-source-manifest.json",
      JSON.stringify({ version: 1, generatedAt: new Date().toISOString(), sources: [] }),
    ],
    ["test.gtfs.zip", "public-synthetic-dataset"],
  ])
    writeFileSync(join(staging, name!), body!, { mode: 0o600 });
  createCandidateManifest(staging, executionId, new Date().toISOString());
}
function linkProxyFixture(data: string) {
  applyHardlinkPlan(
    [
      {
        source: "motis-feed-proxy/conf",
        target: "motis-feed-proxy/motis-feed-proxy-config",
        consumerService: "motis-feed-proxy",
        dataType: "motis-feed-proxy-config",
      },
    ],
    { rootDir: data },
  );
}

it.each(["before-proof", "before-terminal", "after-terminal"] as const)(
  "restarts the actual proxy agent after %s without inventing proof or replaying validation",
  async (crash) => {
    const root = mkdtempSync(join(tmpdir(), "omx-proxy-proof-crash-")),
      data = join(root, "data");
    mkdirSync(join(data, "motis-feed-proxy/conf"), { mode: 0o700, recursive: true });
    writeFileSync(join(data, "motis-feed-proxy/conf/default.conf"), "server { listen 80; }\n", {
      mode: 0o600,
    });
    writeFileSync(join(data, "motis-feed-proxy/feed-proxy-vars.json"), "{}\n", { mode: 0o600 });
    linkProxyFixture(data);
    await control.provisionControlInstallation(root);
    const dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["motis-feed-proxy"],
    });
    const agentVerifier = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis-feed-proxy"],
    });
    const deadlineAt = Date.now() + 120000,
      operationKey = createControlRootOperationKey({
        notAfter: deadlineAt,
        nonce: randomBytes(16),
      });
    const input = { kind: "transit-sync", countries: ["de"] },
      operationFingerprint = createHash("sha256").update(canonicalJson(input)).digest("hex");
    const parent: ExecutionRef = {
      executor: "data-manager",
      principal: "data-manager",
      executionId: randomUUID(),
      operationKey,
      operationFingerprint,
      deadlineAt,
      fingerprint: executionFingerprint({ kind: input.kind, operationFingerprint, deadlineAt }),
    };
    const operation = {
      kind: "feedProxy.validateAndReload" as const,
      candidateId: transitChildCandidateId(parent, "proxy-stage", 0),
    };
    const reservation: control.ControlChildReservation = {
      version: 1,
      phase: "proxy-stage",
      ordinal: 0,
      kind: operation.kind,
      recipient: "ops-agent",
      serviceIds: ["motis-feed-proxy"],
      operationFingerprint: opsOperationFingerprint(operation),
      execution: {
        executor: "ops-agent",
        principal: "data-manager",
        executionId: `job1_${randomUUID().replaceAll("-", "")}`,
        operationKey: control.controlChildOperationKey(operationKey, "proxy-stage", 0),
      },
    };
    const authority = control.retainAdmittedControlExecution(dm, {
      execution: parent,
      kind: input.kind,
      operation: input,
      admittedAt: Date.now(),
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["motis-feed-proxy"],
      reservations: [reservation],
    });
    const lease = await control.acquireArtifactTargetLease({
      dataRoot: data,
      serviceIds: ["motis-feed-proxy"],
      owner: authority,
    });
    control.retainOwnedDataTransitCandidate(authority, reservation);
    const bound = await control.bindControlChildPhase(authority, reservation),
      issued = await control.issueControlChildPhase(authority, {
        ...reservation,
        lease,
        childPublicKey: agentVerifier.publicKey,
      });
    const token = "e".repeat(43),
      tokenFile = join(root, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    async function start(fault?: typeof crash) {
      const child = spawn(process.execPath, [bundle], { stdio: ["pipe", "pipe", "pipe"] }),
        lines = createInterface({ input: child.stdout }),
        iterator = lines[Symbol.asyncIterator]();
      let stderr = "";
      child.stderr.on("data", (data) => {
        stderr += String(data);
      });
      const exited = new Promise<number | null>((resolve) => child.once("close", resolve));
      child.stdin.write(
        JSON.stringify({
          root,
          token,
          validationFailure: true,
          ...(fault ? { crash: fault } : {}),
        }) + "\n",
      );
      const first = await iterator.next();
      if (first.done) throw Error("Agent startup failed: " + stderr);
      const ready = JSON.parse(first.value) as { type: string; port: number };
      expect(ready.type).toBe("ready");
      return {
        child,
        lines,
        exited,
        client: new OpsClient({ baseUrl: `http://127.0.0.1:${ready.port}`, tokenFile }),
        async close() {
          if (child.exitCode === null) {
            child.stdin.write('{"type":"close"}\n');
            child.stdin.end();
          }
          await exited;
          lines.close();
        },
      };
    }
    let first: Awaited<ReturnType<typeof start>> | undefined,
      restarted: Awaited<ReturnType<typeof start>> | undefined;
    try {
      first = await start(crash);
      control.consumeControlChildDispatch(issued.dispatchTicket);
      await first.client
        .execute(operation, {
          operationKey: bound.execution.operationKey,
          execution: { requestedDeadlineAt: bound.execution.deadlineAt },
          controlAssertion: issued.assertion,
        })
        .catch(() => undefined);
      expect(await first.exited).toBe(86);
      const terminalPath = join(
        root,
        "control-private/ops-agent/observations",
        `terminal-${bound.execution.operationKey}.json`,
      );
      const originalTerminal = existsSync(terminalPath)
        ? JSON.parse(readFileSync(terminalPath, "utf8"))?.payload
        : undefined;
      restarted = await start();
      const status = await restarted.client.lookup(operation, bound.execution.operationKey, {
        fingerprint: bound.execution.fingerprint,
      });
      expect(status.operationId).toBe(bound.execution.executionId);
      expect(status.deadlineAt).toBe(bound.execution.deadlineAt);
      if (crash === "after-terminal") {
        expect(status.state).toBe("failed");
        expect(status.errorClass).toBe("runtime");
        expect(control.verifyFeedProxyCanonicalTerminal(authority, bound.execution).state).toBe(
          "failed",
        );
        expect(
          control.inspectArtifactTargetLeaseChildSettlement(lease, bound.execution),
        ).toMatchObject({ outcome: "contained", publication: "not_started" });
        const repaired = JSON.parse(readFileSync(terminalPath, "utf8")).payload;
        expect(repaired.terminalDigest).toBe(originalTerminal.terminalDigest);
        expect(repaired.terminalAt).toBe(originalTerminal.terminalAt);
      } else {
        expect(status.errorClass).toBe("recovery_required");
        expect(() =>
          control.verifyFeedProxyCanonicalTerminal(authority, bound.execution),
        ).toThrow();
      }
      const jobs = JSON.parse(readFileSync(join(root, "state/ops-agent/jobs-v1.json"), "utf8"));
      expect(JSON.stringify(jobs)).toContain(bound.execution.operationKey);
      await expect(control.releaseArtifactTargetLease(lease)).rejects.toThrow();
      expect(existsSync(join(data, ".admin-target-control/locks/motis-feed-proxy"))).toBe(true);
      // No POST is sent to the restarted process; original admission remains.
    } finally {
      await first?.close();
      await restarted?.close();
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agentVerifier);
      control.closeControlInstallation(dm);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
