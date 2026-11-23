import { randomBytes, randomUUID } from "node:crypto";
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
  type HardlinkEntry,
  isDataExecutionTerminal,
  LOCAL_DATA_EXECUTION_KINDS,
  SHORT_DATA_EXECUTION_KINDS,
} from "@openmapx/core/data-manager-contracts";
import { createDataManagerTransport } from "@openmapx/core/data-manager-sdk";
import {
  createControlRootOperationKey,
  type OpsClient,
  OpsClientError,
  type OpsJobStatus,
  parseControlRootOperationKey,
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
import { createDataConfigurationMaintenance } from "./configuration-maintenance.js";
import { installLocalDataExecutions } from "./local.js";
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
    leaseId: null,
  },
};
/** The kinds whose in-process work stores only its kind; a hardlink
 * application stores what it linked, and has tests of its own below. */
const KIND_ONLY_LOCAL_KINDS = LOCAL_DATA_EXECUTION_KINDS.filter(
  (kind) => kind !== "generation-link",
);
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
  async function harness(
    options: { infraDir?: string; fence?: boolean; leases?: control.LeaseBackend } = {},
  ) {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 6 });
    const root = options.infraDir ?? mkdtempSync(join(tmpdir(), "omx-local-executions-"));
    mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
    await control.provisionControlDirectories(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager"],
        ...(options.leases ? { leases: options.leases } : {}),
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      fence = options.fence ? createDataConfigurationMaintenance(sql, installation) : undefined;
    await fence?.startup();
    const store = createPostgresDataExecutionStore(sql, {
      controlJournal: journal,
      ...(fence ? { configurationFence: fence } : {}),
    });
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

  it.each(KIND_ONLY_LOCAL_KINDS)(
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
      // Every record of a run is on its job row; no file is named after it.
      const named = () => files().filter((name) => batch.some((key) => name.includes(key)));
      const rows = () =>
        h.sql`SELECT id FROM data_manager.jobs WHERE operation_key = ANY(${batch})`;
      const executionRows = () =>
        h.sql`SELECT id FROM data_manager.jobs WHERE operation_key = ANY(${batch}) AND execution_admission IS NOT NULL`;
      expect(named()).toEqual([]);
      expect(await executionRows()).toHaveLength(30);
      const removed = await control.pruneControlRecords(h.installation, { now: pruneAfter });
      expect(removed.sort()).toEqual([...batch].sort());
      // The job rows stay for the API's job retention, without their execution rows.
      expect(await executionRows()).toHaveLength(0);
      expect(await rows()).toHaveLength(30);
    }
  }, 120_000);

  /** A checkout whose applied generation names a plan with work, and
   * data-manager's `/link` on the durable runtime, both over one data
   * directory. Requests can be sent as the host CLI or the agent. */
  async function linkFixture(
    options: { fence?: boolean; entries?: HardlinkEntry[]; leases?: control.LeaseBackend } = {},
  ) {
    const repo = mkdtempSync(join(tmpdir(), "omx-link-checkout-")),
      infra = join(repo, "infra", "docker"),
      data = join(infra, "data"),
      revisionId = `cfg1_${"g".repeat(43)}`;
    writeFileSync(join(repo, "pnpm-workspace.yaml"), "packages: []\n");
    mkdirSync(join(repo, "services"));
    mkdirSync(join(infra, services.CONFIGURATION_GENERATIONS, revisionId), {
      recursive: true,
      mode: 0o700,
    });
    symlinkSync(`generations/${revisionId}`, join(infra, services.CURRENT_CONFIGURATION));
    // Removed last, after the harness has closed the installation inside it.
    cleanups.push(async () => rmSync(repo, { recursive: true, force: true }));
    const h = await harness({ infraDir: infra, fence: options.fence, leases: options.leases }),
      runtime = h.runtime();
    const entries = options.entries ?? [
      {
        source: "data/osm",
        target: "data/valhalla/osm-pbf",
        consumerService: "valhalla",
        dataType: "osm-pbf",
      },
    ];
    writeFileSync(
      join(infra, services.CURRENT_CONFIGURATION, services.GENERATED_HARDLINK_PLAN_FILE),
      JSON.stringify(entries),
      { mode: 0o600 },
    );
    mkdirSync(join(data, "osm"), { recursive: true });
    writeFileSync(join(data, "osm", "planet.osm.pbf"), "PBF");
    // The receiver's own fence and dispatcher are never reached by in-process
    // work; a sender's lease is checked against the store's fence.
    const receiver = createDataExecutionReceiver({
      runtime,
      installation: h.installation,
      configurationFence: {} as never,
      dispatcher: {} as never,
      operationsPolicy: resolveOperationsProfile({ countries: ["de"] }),
    });
    installLocalDataExecutions(receiver);
    const token = "link-fixture-host-cli-token-0123456789abcdef",
      tokens = { api: `${token}-api`, "ops-agent": `${token}-agent`, "host-cli": token },
      tokenFile = join(repo, "data-manager-token"),
      previousToken = process.env.DATA_MANAGER_TOKEN_FILE;
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const app = Fastify();
    registerAuth(app, tokens);
    registerApi(app, { dataDir: data, executionReceiver: receiver });
    const dataManagerUrl = await app.listen({ host: "127.0.0.1", port: 0 });
    process.env.DATA_MANAGER_TOKEN_FILE = tokenFile;
    cleanups.push(async () => {
      if (previousToken === undefined) delete process.env.DATA_MANAGER_TOKEN_FILE;
      else process.env.DATA_MANAGER_TOKEN_FILE = previousToken;
      await app.close();
      await h.sql`DELETE FROM data_manager.jobs WHERE kind='generation-link'`;
      await h.sql`DELETE FROM data_manager.configuration_fence`;
    });
    const send = (
      caller: "host-cli" | "ops-agent",
      leaseId: string | null,
      operationKey = createControlRootOperationKey({
        notAfter: Date.now() + 60_000,
        nonce: randomBytes(16),
      }),
    ) =>
      control.linkGeneration({
        transport: createDataManagerTransport({
          baseUrl: dataManagerUrl,
          authToken: tokens[caller],
        }),
        operationKey,
        deadlineAt: parseControlRootOperationKey(operationKey).notAfter,
        revisionId,
        plan: entries,
        prune: true,
        leaseId,
      });
    const planDigest = control.controlDigest({ plan: entries, prune: true });
    return { h, runtime, repo, infra, data, revisionId, dataManagerUrl, send, planDigest };
  }
  const linkRows = (h: Awaited<ReturnType<typeof harness>>) =>
    h.sql<{ status: string; publication: string; finished: boolean; lease_id: string | null }[]>`
      SELECT status, execution_state->>'publication' AS publication,
        finished_at IS NOT NULL AS finished, execution_input->>'leaseId' AS lease_id
      FROM data_manager.jobs WHERE kind='generation-link' ORDER BY admitted_at`;

  it("applies a generation's hardlink plan with real work from the host CLI through data-manager", async () => {
    const { h, runtime, repo, data, revisionId, dataManagerUrl } = await linkFixture();
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

  it("applies a plan under the lease its sender holds, which refuses data-manager's own lease", async () => {
    const { h, data, send } = await linkFixture({ fence: true });
    // A host operation holding every service, as `control rollback` does.
    const deadline = Date.now() + 60_000,
      owner = {
        executor: "host-cli" as const,
        principal: "host-cli" as const,
        executionId: randomUUID(),
        operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        operationFingerprint: "a".repeat(64),
        deadlineAt: deadline,
        fingerprint: "b".repeat(64),
      },
      leases = control.agentStoreLeases(h.root, "host-cli"),
      held = await control.admitRootLease(leases, {
        owner,
        ownerKind: "control.rollback",
        targets: ["data-manager"],
      });
    // Without its lease id the plan is refused: data-manager cannot lease itself.
    await expect(send("host-cli", null)).rejects.toMatchObject({ reason: "busy" });
    // With it, data-manager links under that lease and takes none of its own.
    const key = control.generationLinkOperationKey(owner, `cfg1_${"g".repeat(43)}`);
    expect(await send("host-cli", held.leaseId, key)).toMatchObject({ linked: 1 });
    expect((await h.leases()).map((lease) => lease.leaseId)).toEqual([held.leaseId]);
    expect(statSync(join(data, "valhalla", "osm-pbf", "planet.osm.pbf")).ino).toBe(
      statSync(join(data, "osm", "planet.osm.pbf")).ino,
    );
    // The same key observes the application it names instead of running another.
    expect(await send("host-cli", held.leaseId, key)).toMatchObject({ linked: 1, skipped: 0 });
    expect((await linkRows(h)).map((row) => [row.status, row.lease_id])).toEqual([
      ["error", null],
      ["ok", held.leaseId],
    ]);
    // The sender settles its own lease from the answer it got.
    await leases.settle({
      leaseId: held.leaseId,
      key: null,
      settlement: {
        identity: owner,
        outcome: "committed",
        publication: "committed",
        terminalReceiptDigest: "0".repeat(64),
      },
    });
    await leases.release({ leaseId: held.leaseId });
  }, 60_000);

  /** A root owner for a sender's lease, as the agent or the host CLI records it. */
  function senderOwner(executor: "host-cli" | "ops-agent") {
    const deadline = Date.now() + 60_000;
    return {
      executor,
      principal: executor === "ops-agent" ? ("api" as const) : ("host-cli" as const),
      executionId: executor === "ops-agent" ? `job1_${"s".repeat(32)}` : randomUUID(),
      operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
      operationFingerprint: "a".repeat(64),
      deadlineAt: deadline,
      fingerprint: "b".repeat(64),
    };
  }

  /** Leases in the agent's store, taken and given back the way their holders do. */
  function senderLeases(root: string) {
    const leases = control.agentStoreLeases(root, "host-cli");
    return {
      take: async (executor: "host-cli" | "ops-agent", targets: string[]) => {
        const owner = senderOwner(executor);
        const lease = await control.admitRootLease(leases, {
          owner,
          ownerKind: "control.rollback",
          targets,
        });
        return { leaseId: lease.leaseId, owner };
      },
      giveBack: async (held: { leaseId: string; owner: ReturnType<typeof senderOwner> }) => {
        await leases.settle({
          leaseId: held.leaseId,
          key: null,
          settlement: {
            identity: held.owner,
            outcome: "committed",
            publication: "committed",
            terminalReceiptDigest: "0".repeat(64),
          },
        });
        await leases.release({ leaseId: held.leaseId });
      },
    };
  }

  it("refuses without effect a lease its sender does not hold live on data-manager", async () => {
    const { h, data, send } = await linkFixture({ fence: true });
    const leases = senderLeases(h.root);
    const refused = async (leaseId: string) => {
      await expect(send("host-cli", leaseId)).rejects.toMatchObject({ reason: "refused" });
      expect(await linkRows(h)).toEqual([]);
      expect(() => statSync(join(data, "valhalla", "osm-pbf", "planet.osm.pbf"))).toThrow();
    };
    // A lease off data-manager, a released one and an unknown one.
    const elsewhere = await leases.take("host-cli", ["valhalla"]);
    await refused(elsewhere.leaseId);
    await leases.giveBack(elsewhere);
    const released = await leases.take("host-cli", ["data-manager"]);
    await leases.giveBack(released);
    await refused(released.leaseId);
    await refused(randomUUID());
    // Another sender's lease is refused; its own sender is accepted under it.
    const agents = await leases.take("ops-agent", ["data-manager"]);
    await refused(agents.leaseId);
    expect(await send("ops-agent", agents.leaseId)).toMatchObject({ linked: 1 });
    expect((await linkRows(h)).map((row) => [row.status, row.lease_id])).toEqual([
      ["ok", agents.leaseId],
    ]);
    expect(statSync(join(data, "valhalla", "osm-pbf", "planet.osm.pbf")).ino).toBe(
      statSync(join(data, "osm", "planet.osm.pbf")).ino,
    );
    await leases.giveBack(agents);
  }, 60_000);

  it("refuses without effect a lease the agent cannot be asked about", async () => {
    const unreachable = control.remoteLeaseBackend(async () => {
      throw new OpsClientError("timeout");
    });
    const { h, data, send } = await linkFixture({ fence: true, leases: unreachable });
    const leases = senderLeases(h.root);
    const held = await leases.take("host-cli", ["data-manager"]);
    await expect(send("host-cli", held.leaseId)).rejects.toMatchObject({ reason: "unavailable" });
    expect(await linkRows(h)).toEqual([]);
    expect(() => statSync(join(data, "valhalla", "osm-pbf", "planet.osm.pbf"))).toThrow();
    await leases.giveBack(held);
  }, 60_000);

  it("beside a prepared fence admits only its maintenance's own plan, under that maintenance's lease", async () => {
    const { h, runtime, revisionId, send, planDigest } = await linkFixture({ fence: true });
    const deadline = Date.now() + 60_000,
      ownerPrepare = {
        executor: "ops-agent" as const,
        principal: "api" as const,
        executionId: `job1_${"p".repeat(32)}`,
        operationKey: createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        operationFingerprint: "c".repeat(64),
        deadlineAt: deadline,
        fingerprint: "d".repeat(64),
      },
      maintenanceId = randomUUID();
    await h.sql`INSERT INTO data_manager.configuration_fence
      (maintenance_id, fence_id, operation_key, candidate_id, plan_digest, input, state)
      VALUES (${maintenanceId}::uuid, ${randomUUID()}::uuid, ${ownerPrepare.operationKey},
        ${randomUUID()}::uuid, ${"e".repeat(64)}, ${h.sql.json({
          maintenanceId,
          candidateId: randomUUID(),
          ownerPrepare,
          planDigest: "e".repeat(64),
          revisionId,
          hardlinkPlanDigest: planDigest,
          serviceIds: ["data-manager"],
          coordinatorMode: "require-running",
        })}, 'prepared')`;
    const own = control.rootLeaseId(ownerPrepare);
    // No other job, sender or lease gets past the prepared fence.
    await expect(send("ops-agent", null)).rejects.toMatchObject({ reason: "busy" });
    await expect(send("host-cli", own)).rejects.toMatchObject({ reason: "busy" });
    await expect(send("ops-agent", randomUUID())).rejects.toMatchObject({ reason: "busy" });
    await expect(h.admit(runtime, { kind: "download-fonts" })).rejects.toThrow(
      "configuration_maintenance_busy",
    );
    // The maintenance's own step, sent by the agent under the maintenance's lease.
    expect(await send("ops-agent", own)).toMatchObject({ linked: 1 });
    expect((await linkRows(h)).map((row) => [row.status, row.lease_id])).toEqual([["ok", own]]);
    expect(await h.leases()).toEqual([]);
  }, 60_000);

  it("ends a plan that fails part-way as failed with links that may have changed, and blocks nothing", async () => {
    const { h, runtime, data, send } = await linkFixture({ fence: true });
    // Another service's file where the plan needs a directory.
    writeFileSync(join(data, "valhalla"), "not a directory");
    const key = createControlRootOperationKey({
      notAfter: Date.now() + 60_000,
      nonce: randomBytes(16),
    });
    await expect(send("host-cli", null, key)).rejects.toBeInstanceOf(control.GenerationLinkFailed);
    // A known outcome: the row is final with its publication committed, so it
    // keeps neither data jobs, nor configuration changes, nor a lease held.
    expect(await linkRows(h)).toEqual([
      { status: "error", publication: "committed", finished: true, lease_id: null },
    ]);
    await expect.poll(() => h.leases(), { timeout: 15_000 }).toEqual([]);
    expect(
      await h.sql`SELECT id FROM data_manager.jobs WHERE execution_state->>'publication'='unknown'`,
    ).toEqual([]);
    // Asking again under the same key reports the same outcome without a second run.
    await expect(send("host-cli", null, key)).rejects.toBeInstanceOf(control.GenerationLinkFailed);
    expect(await linkRows(h)).toHaveLength(1);
    const fonts = await h.admit(runtime, { kind: "download-fonts" });
    h.fonts.release.resolve();
    expect((await h.terminal(runtime, fonts.id)).status).toBe("ok");
  }, 60_000);
});
