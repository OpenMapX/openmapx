import { randomBytes } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  type DataExecutionInput,
  type DataExecutionStatus,
  isDataExecutionTerminal,
  LOCAL_DATA_EXECUTION_KINDS,
  SHORT_DATA_EXECUTION_KINDS,
} from "@openmapx/core/data-manager-contracts";
import {
  createControlRootOperationKey,
  type OpsClient,
  OpsClientError,
  type OpsJobStatus,
} from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import Fastify from "fastify";
import postgres from "postgres";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyGeneratedHardlinks,
  DataManagerBusyError,
} from "../../../../../packages/cli/src/lib/hardlinks.js";
import { registerApi } from "../../api.js";
import { registerAuth } from "../../auth.js";
import { resetOpsClient, runOpsOperation } from "../../ops-client.js";
import { resolveOperationsProfile } from "../transitous/operations-profile.js";
import { installLocalDataExecutions } from "./local.js";
import { removePrunedDataRows } from "./prune-rows.js";
import { createDataExecutionReceiver } from "./receiver.js";
import { createDataExecutionRuntime, type DataExecutionRuntime } from "./runtime.js";
import { createPostgresDataExecutionStore } from "./store.js";
import { dataExecutionWorkerContext } from "./worker-scope.js";

const inputs: Record<(typeof LOCAL_DATA_EXECUTION_KINDS)[number], DataExecutionInput> = {
  "traffic-live": { kind: "traffic-live" },
  "traffic-maintenance": { kind: "traffic-maintenance", task: "ways-to-edges" },
  "traffic-predicted": { kind: "traffic-predicted" },
  "transit-proposal": {
    kind: "transit-proposal",
    proposalId: "00000000-0000-4000-8000-000000000042",
  },
  "data-reload": { kind: "data-reload" },
  "ambient-publication": { kind: "ambient-publication", action: "enable" },
  "generation-link": {
    kind: "generation-link",
    revisionId: `cfg1_${"g".repeat(43)}`,
    planDigest: "d".repeat(64),
  },
};
const reserved: Record<string, string[]> = {
  "traffic-maintenance": ["valhalla.traffic.maintain", "valhalla.traffic.refreshWaysToEdges"],
  "traffic-predicted": ["valhalla.traffic.maintain"],
  "transit-proposal": ["transitousLock.propose"],
};
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
/** An agent that admits each request after `onExecute` and answers lookups
 * with `state()`. */
function fakeAgent(
  state: () => OpsJobStatus["state"],
  onExecute?: (signal?: AbortSignal) => Promise<void>,
) {
  const posts: string[] = [];
  const client = {
    async execute(
      operation: { kind: string },
      options: { operationKey: string; signal?: AbortSignal },
    ) {
      posts.push(options.operationKey);
      await onExecute?.(options.signal);
      return { execution: "async", kind: operation.kind, operationId: `job1_${"a".repeat(22)}` };
    },
    async lookup(
      operation: { kind: OpsJobStatus["kind"] },
      operationKey: string,
      options: { fingerprint: string; execution: { requestedDeadlineAt: number } },
    ): Promise<OpsJobStatus> {
      const now = new Date().toISOString();
      const current = state();
      return {
        version: 2,
        admittedAt: Date.now(),
        deadlineAt: options.execution.requestedDeadlineAt,
        fingerprint: options.fingerprint,
        operationId: `job1_${"a".repeat(22)}`,
        operationKey,
        kind: operation.kind,
        resourceId: "valhalla",
        state: current,
        submittedAt: now,
        updatedAt: now,
        ...(current === "succeeded" ? { result: { changed: true } } : {}),
      } as OpsJobStatus;
    },
    async cancel() {
      throw new OpsClientError("runtime");
    },
  };
  return { client: client as unknown as OpsClient, posts };
}

describe.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)("local data executions", () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    resetOpsClient();
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });
  async function harness() {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 6 });
    const root = mkdtempSync(join(tmpdir(), "omx-local-executions-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    const fonts = { started: deferred(), release: deferred() };
    const runtimes: DataExecutionRuntime[] = [];
    const keys: string[] = [];
    const runtime = () => {
      const created = createDataExecutionRuntime({
        store,
        dispatch: async () => {
          fonts.started.resolve();
          await fonts.release.promise;
          return { kind: "download-fonts", completed: true };
        },
      });
      runtimes.push(created);
      return created;
    };
    const admit = (
      target: DataExecutionRuntime,
      input: DataExecutionInput,
      work?: () => Promise<unknown>,
    ) => {
      const deadline = Date.now() + 60_000,
        operationKey = createControlRootOperationKey({
          notAfter: deadline,
          nonce: randomBytes(16),
        });
      keys.push(operationKey);
      return target.admit(input, {
        operationKey,
        requestedDeadlineAt: deadline,
        ...(work
          ? {
              work: async () => {
                await work();
                return { kind: input.kind } as never;
              },
            }
          : {}),
      });
    };
    const leases = () =>
      control
        .openLeaseStore({ directory: control.leaseStoreDirectory(root), purpose: "test" })
        .list();
    const terminal = async (target: DataExecutionRuntime, id: string) => {
      await expect
        .poll(
          async () => {
            const status = await target.inspect(id);
            return status && isDataExecutionTerminal(status) ? status.status : null;
          },
          { timeout: 20_000 },
        )
        .not.toBeNull();
      return (await target.inspect(id)) as DataExecutionStatus;
    };
    cleanups.push(async () => {
      fonts.release.resolve();
      for (const created of runtimes) await created.close();
      await sql`DELETE FROM data_manager.jobs WHERE operation_key = ANY(${keys})`;
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    });
    return { sql, root, installation, store, runtime, admit, leases, terminal, fonts, keys };
  }

  it("runs live traffic while an exclusive job holds data-manager, and refuses a second exclusive job", async () => {
    const h = await harness(),
      runtime = h.runtime();
    const fonts = await h.admit(runtime, { kind: "download-fonts" });
    await h.fonts.started.promise;
    expect(await h.leases()).toHaveLength(1);
    let leasesDuringLive: unknown[] | undefined;
    const live = await h.admit(runtime, { kind: "traffic-live" }, async () => {
      leasesDuringLive = await h.leases();
    });
    expect((await h.terminal(runtime, live.id)).status).toBe("ok");
    // The live run took no lease of its own beside the exclusive job's.
    expect(leasesDuringLive).toHaveLength(1);
    await expect(h.admit(runtime, { kind: "data-reload" }, async () => {})).rejects.toThrow(
      "configuration_maintenance_busy",
    );
    h.fonts.release.resolve();
    expect((await h.terminal(runtime, fonts.id)).status).toBe("ok");
    await expect.poll(() => h.leases(), { timeout: 15_000 }).toEqual([]);
  }, 60_000);

  it.each(LOCAL_DATA_EXECUTION_KINDS)(
    "admits %s with its agent reservations and its lease class, and runs it to its terminal",
    async (kind) => {
      const h = await harness(),
        runtime = h.runtime();
      let leasesDuringWork: Array<{ targets?: readonly string[] }> | undefined;
      const admitted = await h.admit(runtime, inputs[kind], async () => {
        leasesDuringWork = (await h.leases()) as never;
      });
      const record = await h.store.inspect(admitted.id);
      expect(record?.input).toEqual(inputs[kind]);
      expect(record?.agentOperations.map((entry) => [entry.kind, entry.state])).toEqual(
        (reserved[kind] ?? []).map((operation) => [operation, "reserved"]),
      );
      const done = await h.terminal(runtime, admitted.id);
      expect(done).toMatchObject({ status: "ok", result: { kind } });
      // Short traffic runs hold no lease; the others lease data-manager.
      expect(leasesDuringWork).toHaveLength(SHORT_DATA_EXECUTION_KINDS.includes(kind) ? 0 : 1);
      // Reservations the work never used do not keep the execution open.
      expect((await h.store.inspect(admitted.id))?.finishedAt).not.toBeNull();
      await expect.poll(() => h.leases(), { timeout: 15_000 }).toEqual([]);
    },
    60_000,
  );

  it.each(["traffic-live", "ambient-publication"] as const)(
    "cancels a running %s execution and releases what it holds",
    async (kind) => {
      const h = await harness(),
        runtime = h.runtime(),
        running = deferred();
      const admitted = await h.admit(runtime, inputs[kind], async () => {
        const signal = dataExecutionWorkerContext()?.signal;
        if (!signal) throw Error("Worker scope required");
        running.resolve();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
      });
      await running.promise;
      await runtime.requestCancel({
        id: admitted.id,
        operationKey: admitted.operationKey,
        fingerprint: admitted.fingerprint,
      });
      expect((await h.terminal(runtime, admitted.id)).status).toBe("canceled");
      await expect.poll(() => h.leases(), { timeout: 15_000 }).toEqual([]);
    },
    60_000,
  );

  it("records an agent operation as attempted before its one request and ends only after its terminal", async () => {
    const h = await harness(),
      runtime = h.runtime();
    let polls = 0,
      id = "",
      stateAtPost: string | undefined;
    const agent = fakeAgent(
      () => (++polls < 3 ? "running" : "succeeded"),
      async () => {
        stateAtPost = (await h.store.inspect(id))?.agentOperations.find(
          (op) => op.kind === "valhalla.traffic.refreshWaysToEdges",
        )?.state;
      },
    );
    resetOpsClient(agent.client);
    let second: unknown;
    const admitted = await h.admit(runtime, inputs["traffic-maintenance"], async () => {
      await runOpsOperation(
        { kind: "valhalla.traffic.refreshWaysToEdges" },
        { pollIntervalMs: 10 },
      );
      second = await runOpsOperation({ kind: "valhalla.traffic.refreshWaysToEdges" }).catch(
        (error: Error) => error.message,
      );
    });
    id = admitted.id;
    const done = await h.terminal(runtime, admitted.id);
    expect(done.status).toBe("ok");
    expect(agent.posts).toHaveLength(1);
    expect(stateAtPost).toBe("attempted");
    expect(second).toMatch(/no valhalla.traffic.refreshWaysToEdges reservation left/);
    const record = await h.store.inspect(admitted.id);
    expect(record?.agentOperations.map((op) => [op.kind, op.state])).toEqual([
      ["valhalla.traffic.maintain", "reserved"],
      ["valhalla.traffic.refreshWaysToEdges", "terminal"],
    ]);
  }, 60_000);

  it("ends an in-process execution its process left behind as interrupted once the agent answers, never before", async () => {
    const h = await harness(),
      dead = h.runtime(),
      requested = deferred();
    let answer: OpsJobStatus["state"] = "running";
    // The first process sends the request and never sees the reply. Its worker
    // stands for a dead process until the test lets it go.
    const gone = deferred();
    const agent = fakeAgent(
      () => answer,
      async () => {
        requested.resolve();
        await gone.promise;
        throw Error("The process ended");
      },
    );
    resetOpsClient(agent.client);
    const admitted = await h.admit(dead, inputs["traffic-maintenance"], async () => {
      await runOpsOperation({ kind: "valhalla.traffic.refreshWaysToEdges" });
    });
    await requested.promise;
    // A new process reconciles while the agent still runs the operation.
    const next = h.runtime();
    await next.reconcile();
    await new Promise((resolve) => setTimeout(resolve, 500));
    const held = await h.store.inspect(admitted.id);
    expect(held && isDataExecutionTerminal(held.status)).toBe(false);
    expect(held?.finishedAt).toBeNull();
    answer = "succeeded";
    const done = await h.terminal(next, admitted.id);
    expect(done).toMatchObject({ status: "interrupted", publication: "committed" });
    expect(
      (await h.store.inspect(admitted.id))?.agentOperations.find(
        (op) => op.kind === "valhalla.traffic.refreshWaysToEdges",
      ),
    ).toMatchObject({ state: "terminal", agentState: "succeeded" });
    expect(agent.posts).toHaveLength(1);
    gone.resolve();
    await dead.settled(admitted.id);
    expect((await h.store.inspect(admitted.id))?.status.status).toBe("interrupted");
  }, 60_000);

  it("keeps the records of many short runs bounded by the prune", async () => {
    const h = await harness(),
      runtime = h.runtime();
    const pruneAfter = Date.now() + control.CONTROL_PRUNE_AFTER_MS + 3_600_000;
    const files = () => {
      const names: string[] = [];
      const walk = (dir: string) => {
        for (const entry of readdirSync(dir, { withFileTypes: true }))
          if (entry.isDirectory()) walk(join(dir, entry.name));
          else names.push(entry.name);
      };
      for (const entry of readdirSync(h.root, { withFileTypes: true }))
        if (entry.isDirectory() && entry.name !== "data") walk(join(h.root, entry.name));
      return names;
    };
    for (let round = 0; round < 2; round++) {
      const batch: string[] = [];
      for (let cycle = 0; cycle < 30; cycle++) {
        const admitted = await h.admit(runtime, { kind: "traffic-live" }, async () => {});
        batch.push(admitted.operationKey);
        await runtime.settled(admitted.id);
      }
      const named = () => files().filter((name) => batch.some((key) => name.includes(key)));
      expect(named().length).toBeGreaterThan(30);
      const removed = await control.pruneControlRecords(h.installation, {
        now: pruneAfter,
        beforeRemove: (keys) => removePrunedDataRows(h.sql, keys),
      });
      expect(removed.sort()).toEqual([...batch].sort());
      expect(named()).toEqual([]);
      expect(
        await h.sql`SELECT id FROM data_manager.jobs WHERE operation_key = ANY(${batch})`,
      ).toHaveLength(0);
    }
  }, 120_000);

  it("applies a generation's hardlink plan with real work from the host CLI through data-manager", async () => {
    const h = await harness(),
      runtime = h.runtime();
    // A checkout whose applied generation has a plan with work.
    const repo = mkdtempSync(join(tmpdir(), "omx-link-checkout-")),
      infra = join(repo, "infra", "docker"),
      data = join(infra, "data"),
      revisionId = `cfg1_${"g".repeat(43)}`;
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(repo, "services"));
    mkdirSync(join(infra, services.CONFIGURATION_GENERATIONS), { recursive: true });
    mkdirSync(join(infra, services.CONFIGURATION_GENERATIONS, revisionId), { mode: 0o700 });
    symlinkSync(`generations/${revisionId}`, join(infra, services.CURRENT_CONFIGURATION));
    const entry = {
      source: "data/osm",
      target: "data/valhalla/osm-pbf",
      consumerService: "valhalla",
      dataType: "osm-pbf",
    };
    writeFileSync(
      join(infra, services.CURRENT_CONFIGURATION, services.GENERATED_HARDLINK_PLAN_FILE),
      JSON.stringify([entry]),
      { mode: 0o600 },
    );
    mkdirSync(join(data, "osm"), { recursive: true });
    writeFileSync(join(data, "osm", "planet.osm.pbf"), "PBF");
    // Data-manager's route on the durable runtime. The receiver's fence and
    // dispatcher are never reached by in-process work.
    const receiver = createDataExecutionReceiver({
      runtime,
      installation: h.installation,
      configurationFence: {} as never,
      dispatcher: {} as never,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
    });
    installLocalDataExecutions(receiver);
    const token = "link-fixture-host-cli-token-0123456789abcdef",
      tokenFile = join(repo, "data-manager-token"),
      previousToken = process.env.DATA_MANAGER_TOKEN_FILE;
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const app = Fastify();
    registerAuth(app, { api: `${token}-api`, "ops-agent": `${token}-agent`, "host-cli": token });
    registerApi(app, { dataDir: data, executionReceiver: receiver });
    const dataManagerUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    process.env.DATA_MANAGER_TOKEN_FILE = tokenFile;
    cleanups.push(async () => {
      if (previousToken === undefined) delete process.env.DATA_MANAGER_TOKEN_FILE;
      else process.env.DATA_MANAGER_TOKEN_FILE = previousToken;
      await app.close();
      await h.sql`DELETE FROM data_manager.jobs WHERE kind='generation-link'`;
      rmSync(repo, { recursive: true, force: true });
    });
    const apply = () =>
      applyGeneratedHardlinks({ rootDir: repo, requirePlan: true, prune: true, dataManagerUrl });

    expect(await apply()).toMatchObject({ applied: true, linked: 1, via: "data-manager" });
    expect(statSync(join(data, "valhalla", "osm-pbf", "planet.osm.pbf")).ino).toBe(
      statSync(join(data, "osm", "planet.osm.pbf")).ino,
    );
    // The same generation's plan again links nothing new.
    expect(await apply()).toMatchObject({ applied: true, linked: 0, skipped: 1 });
    const runs =
      await h.sql`SELECT status, execution_input FROM data_manager.jobs WHERE kind='generation-link' ORDER BY admitted_at`;
    expect(runs.map((row) => [row.status, row.execution_input.revisionId])).toEqual([
      ["ok", revisionId],
      ["ok", revisionId],
    ]);
    // Another data job keeps the plan out until it finishes.
    const fonts = await h.admit(runtime, { kind: "download-fonts" });
    await h.fonts.started.promise;
    await expect(apply()).rejects.toBeInstanceOf(DataManagerBusyError);
    h.fonts.release.resolve();
    expect((await h.terminal(runtime, fonts.id)).status).toBe("ok");
    await expect.poll(() => h.leases(), { timeout: 15_000 }).toEqual([]);
  }, 60_000);
});
