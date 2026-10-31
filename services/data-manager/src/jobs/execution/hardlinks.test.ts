import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  createDataManagerTransport,
  lookupDataExecution,
  observeDataExecution,
  startGenerationHardlinksExecution,
  unwrapDataManagerResponse,
} from "@openmapx/core/data-manager-sdk";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  OpsClient,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import Fastify from "fastify";
import postgres from "postgres";
import { expect, it } from "vitest";
import { registerApi } from "../../api";
import { registerAuth } from "../../auth";
import { resetOpsClient } from "../../ops-client";
import { StateStore } from "../../state";
import { resolveOperationsProfile } from "../transitous/operations-profile";
import { getSingleFlightController } from "../transitous/runtime";
import { createDataConfigurationMaintenance } from "./configuration-maintenance";
import { createDataExecutionDispatcher } from "./dispatch";
import { applyOwnedGenerationHardlinks } from "./hardlinks";
import { createDataExecutionReceiver } from "./receiver";
import { createDataExecutionRuntime } from "./runtime";
import { createPostgresDataExecutionStore } from "./store";

it
  .skipIf(
    !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
      process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
  )
  .each(["ordinary", "restart"] as const)(
  "observes an ordinary signed generation leaf after response loss without repeat pruning or container lifecycle (%s)",
  async (mode) => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-generation-leaf-")),
      data = join(root, "data");
    mkdirSync(join(data, "src"), { recursive: true });
    writeFileSync(join(data, "src/fixture"), "public-artifact");
    await control.provisionControlInstallation(root);
    const services = ["consumer", "data-manager"],
      host = control.openControlInstallation({
        infraDir: root,
        role: "host-cli",
        serviceIds: services,
      }),
      dm = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: services,
      }),
      journal = control.createDataExecutionControlJournal(dm, sql),
      fence = createDataConfigurationMaintenance(sql, dm);
    await fence.startup();
    const now = Date.now(),
      deadline = now + 60000,
      operation = { kind: "data.link" as const },
      owner: ExecutionRef = {
        executor: "host-cli",
        principal: "host-cli",
        executionId: randomUUID(),
        operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        operationFingerprint: opsOperationFingerprint(operation),
        deadlineAt: deadline,
        fingerprint: executionFingerprint({
          kind: operation.kind,
          operationFingerprint: opsOperationFingerprint(operation),
          deadlineAt: deadline,
        }),
      };
    const plan = {
        plan: [
          { source: "src", target: "consumer", consumerService: "consumer", dataType: "fixture" },
        ],
        prune: true as const,
      },
      planDigest = createHash("sha256").update(canonicalJson(plan)).digest("hex"),
      input = {
        kind: "generation-hardlinks" as const,
        revisionId: `cfg1_${"a".repeat(43)}`,
        planDigest,
        coordinatorMode: "require-running" as const,
      },
      bodyHash = createHash("sha256").update(canonicalJson(input)).digest("hex"),
      child: ExecutionRef = {
        executor: "data-manager",
        principal: "host-cli",
        executionId: randomUUID(),
        operationKey: control.controlChildOperationKey(owner.operationKey, "hardlinks", 0),
        operationFingerprint: bodyHash,
        deadlineAt: deadline,
        fingerprint: executionFingerprint({
          kind: input.kind,
          operationFingerprint: bodyHash,
          deadlineAt: deadline,
          parent: control.retainedControlParent(owner),
        }),
      },
      slot = {
        phase: "hardlinks" as const,
        ordinal: 0,
        kind: input.kind,
        recipient: "data-manager" as const,
        execution: child,
        serviceIds: services,
      };
    const authority = control.retainAdmittedControlExecution(host, {
        execution: owner,
        kind: operation.kind,
        operation,
        admittedAt: now,
        requestedDeadlineAt: deadline,
        serviceIds: services,
        plan: [slot],
      }),
      lease = await control.acquireArtifactTargetLease({
        dataRoot: data,
        serviceIds: services,
        owner: authority,
      }),
      assertion = await control.delegateArtifactTargetLease(lease, {
        ...slot,
        childPublicKey: dm.publicKey,
      });
    let lifecycle = 0,
      applies = 0;
    const tokenFile = join(root, "token");
    writeFileSync(tokenFile, "a".repeat(43), { mode: 0o600 });
    resetOpsClient(
      new OpsClient({
        baseUrl: "http://127.0.0.1:1",
        tokenFile,
        fetch: async () => {
          lifecycle++;
          throw Error("Generation leaf cannot call host lifecycle");
        },
      }),
    );
    const store = createPostgresDataExecutionStore(sql, {
        controlJournal: journal,
        configurationFence: fence,
      }),
      singleFlight = getSingleFlightController(),
      operationsPolicy = resolveOperationsProfile({ countries: ["de"] }),
      dispatcher = createDataExecutionDispatcher({
        dataDir: data,
        state: new StateStore(data),
        sql,
        singleFlight,
        operationsPolicy,
        runHardlinks: async (context) => {
          applies++;
          return applyOwnedGenerationHardlinks(context);
        },
      }),
      runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch }),
      receiver = createDataExecutionReceiver({
        runtime,
        installation: dm,
        configurationFence: fence,
        dispatcher,
        operationsPolicy,
      }),
      app = Fastify();
    const prepareTerminal = journal.prepareTerminal.bind(journal);
    let failTerminal = mode === "restart";
    journal.prepareTerminal = async (...args) => {
      if (failTerminal) {
        failTerminal = false;
        throw Error("Synthetic crash before borrowed terminal preparation");
      }
      return prepareTerminal(...args);
    };
    let restarted: ReturnType<typeof createDataExecutionRuntime> | undefined;
    let posts = 0;
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.url === "/executions/generation-hardlinks" && request.method === "POST") {
        posts++;
        reply.raw.destroy();
      }
      return payload;
    });
    registerAuth(app, "synthetic-gen-token", { executionReceiver: () => receiver });
    registerApi(app, {
      dataDir: data,
      singleFlight,
      operationsPolicy,
      executionReceiver: receiver,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("Generation endpoint missing");
    const transport = createDataManagerTransport({
      baseUrl: `http://127.0.0.1:${address.port}`,
      authToken: "synthetic-gen-token",
    });
    try {
      await expect(receiver.admitLocal({ kind: "transit-sync", countries: [] })).rejects.toThrow(
        "Countries outside configured operations profile",
      );
      await expect(
        startGenerationHardlinksExecution(
          { operationKey: child.operationKey, requestedDeadlineAt: deadline, input, plan },
          { transport, headers: { "x-openmapx-control-delegation": assertion } },
        ),
      ).rejects.toThrow();
      const admitted = unwrapDataManagerResponse(
        await lookupDataExecution(child.operationKey, { transport }),
      );
      expect(admitted.id).toBe(child.executionId);
      if (mode === "restart") {
        await expect.poll(() => failTerminal, { timeout: 15000 }).toBe(false);
        await expect
          .poll(async () => (await store.lookup(child.operationKey))?.status.publication, {
            timeout: 15000,
          })
          .toBe("unknown");
        await runtime.close();
        const recovered = await journal.restoreCompletion(child);
        expect(recovered.lease.mode).toBe("borrowed");
        expect(() => control.assertArtifactTargetLeaseForward(recovered.lease)).toThrow();
        control.closeArtifactTargetLeaseHandle(recovered.lease);
        restarted = createDataExecutionRuntime({
          store,
          dispatch: async () => {
            throw Error("Borrowed restart must not repeat hardlink/prune");
          },
        });
        await restarted.reconcile();
        await expect
          .poll(async () => (await store.lookup(child.operationKey))?.status.status, {
            timeout: 15000,
          })
          .toBe("ok");
        expect(existsSync(join(data, ".admin-target-control/locks/data-manager"))).toBe(true);
      }
      const terminal = await observeDataExecution(
        { id: admitted.id, operationKey: child.operationKey, fingerprint: child.fingerprint },
        { transport, observerDeadlineAt: deadline },
      );
      expect(terminal).toMatchObject({
        status: "ok",
        result: { kind: "generation-hardlinks", hardlinks: { linked: 1, via: "data-manager" } },
      });
      await expect
        .poll(() => control.inspectArtifactTargetLeaseChildSettlement(lease, child)?.publication, {
          timeout: 10000,
        })
        .toBe("committed");
      const inode = statSync(join(data, "consumer/fixture")).ino;
      unlinkSync(join(data, "src/fixture"));
      const observed = unwrapDataManagerResponse(
        await lookupDataExecution(child.operationKey, { transport }),
      );
      expect(observed).toEqual(terminal);
      expect(statSync(join(data, "consumer/fixture")).ino).toBe(inode);
      expect(readFileSync(join(data, "consumer/fixture"), "utf8")).toBe("public-artifact");
      expect(applies).toBe(1);
      expect(posts).toBe(1);
      expect(lifecycle).toBe(0);
      expect((await store.inspect(child.executionId))?.children).toEqual([]);
      control.retainControlEffectReceipt(authority, {
        outcome: "committed",
        publication: "committed",
        receipt: { kind: "ops-result", result: { completed: true } },
      });
      await control.settleArtifactTargetLeaseChild(
        lease,
        control.verifyControlEffectSettlement(host, owner),
      );
      await control.releaseArtifactTargetLease(lease);
    } finally {
      await runtime.close();
      await restarted?.close();
      app.server.closeAllConnections();
      await app.close();
      const own = await store.lookup(child.operationKey);
      if (own) await sql`DELETE FROM data_manager.jobs WHERE id=${own.status.id}`;
      resetOpsClient();
      control.closeArtifactTargetLeaseHandle(lease);
      journal.close();
      control.closeControlInstallation(host);
      control.closeControlInstallation(dm);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
