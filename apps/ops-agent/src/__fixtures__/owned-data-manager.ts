import { join } from "node:path";
import { closeControlInstallation, createDataExecutionControlJournal, openControlInstallation, reconcileControlRetention } from "@openmapx/core/build-artifacts";
import Fastify from "fastify";
import { registerApi } from "../../../../services/data-manager/src/api";
import { registerAuth } from "../../../../services/data-manager/src/auth";
import { StateStore } from "../../../../services/data-manager/src/state";
import { resolveOperationsProfile } from "../../../../services/data-manager/src/jobs/transitous/operations-profile";
import { getSingleFlightController } from "../../../../services/data-manager/src/jobs/transitous/runtime";
import { createDataConfigurationMaintenance } from "../../../../services/data-manager/src/jobs/execution/configuration-maintenance";
import { createDataExecutionDispatcher } from "../../../../services/data-manager/src/jobs/execution/dispatch";
import { applyOwnedGenerationHardlinks } from "../../../../services/data-manager/src/jobs/execution/hardlinks";
import { createDataExecutionReceiver } from "../../../../services/data-manager/src/jobs/execution/receiver";
import { createDataExecutionRuntime } from "../../../../services/data-manager/src/jobs/execution/runtime";
import { createPostgresDataExecutionStore } from "../../../../services/data-manager/src/jobs/execution/store";

/** Actual HTTP receiver, SQL admission guard, dispatcher, filesystem leaf and journal. */
export async function ownedDataManager(options: {
  sql: Parameters<typeof createPostgresDataExecutionStore>[0]; infraDir: string; serviceIds: string[]; loseHardlinkResponse?: boolean; losePrepareResponse?: boolean;
  observeSettlementSql?: boolean;
  loseSettlementCommitAcknowledgement?: boolean;
  settlementSqlFault?: "update-ack-loss" | "terminate-before-commit";
  pauseSettlementBeforeCommit?: boolean;
}) {
  let settlementCommits = 0, settlementUpdates = 0, settlementRollbacks = 0, terminatedSettlementSession = false;
  const commitEntered = Promise.withResolvers<void>(), continueCommit = Promise.withResolvers<void>();
  const uncertainConnections = new Set<Awaited<ReturnType<typeof options.sql.reserve>>>();
  // Named external SQL transport fault. The installed production adapter and
  // original reserved PostgreSQL connection still perform the actual UPDATE
  // and COMMIT; only the COMMIT acknowledgement is lost.
  const fenceSql = options.observeSettlementSql || options.loseSettlementCommitAcknowledgement || options.settlementSqlFault ? new Proxy(options.sql, {
    get(target, name) {
      if (name !== "reserve") return Reflect.get(target, name);
      return async () => {
        const connection = await target.reserve();
        return new Proxy(connection, { get(owned, member) {
          if (member !== "unsafe") return Reflect.get(owned, member);
          return async (query: string, parameters?: Parameters<typeof owned.unsafe>[1]) => {
            if (query.startsWith("UPDATE data_manager.jobs SET metadata=jsonb_set")) settlementUpdates++;
            if (query === "COMMIT" && options.pauseSettlementBeforeCommit) { commitEntered.resolve(); await continueCommit.promise; }
            if (query === "COMMIT" && options.settlementSqlFault === "terminate-before-commit") {
              const [session] = await owned.unsafe("SELECT pg_backend_pid() AS pid");
              const [killed] = await options.sql`SELECT pg_terminate_backend(${session!.pid}) AS terminated`;
              if (killed!.terminated !== true) throw Error("Owned settlement backend not terminated");
              terminatedSettlementSession = true;
            }
            const result = await owned.unsafe(query, parameters);
            if (query === "ROLLBACK") settlementRollbacks++;
            if (query.startsWith("UPDATE data_manager.jobs SET metadata=jsonb_set") && options.settlementSqlFault === "update-ack-loss")
              throw Error("External settlement UPDATE acknowledgement lost");
            if (query === "COMMIT") settlementCommits++;
            if (query === "COMMIT" && options.loseSettlementCommitAcknowledgement) {
              uncertainConnections.add(owned);
              throw Error("External settlement COMMIT acknowledgement lost");
            }
            return result;
          };
        } });
      };
    },
  }) : options.sql;
  const installation = openControlInstallation({ infraDir: options.infraDir, role: "data-manager", serviceIds: options.serviceIds });
  const dataDir = join(options.infraDir, "data"), journal = createDataExecutionControlJournal(installation, options.sql);
  const fence = createDataConfigurationMaintenance(fenceSql, installation);
  let startupRecoveryRequired = false;
  try { await fence.startup(); }
  catch {
    // Match services/data-manager/src/service.ts:start: its real boundary
    // retains CLOSED data admission but still starts read/control HTTP after
    // startup recovery fails. This is not a successful guard/readiness proof.
    startupRecoveryRequired = true;
  }
  const store = createPostgresDataExecutionStore(options.sql, { controlJournal: journal, configurationFence: fence });
  const singleFlight = getSingleFlightController(), operationsPolicy = resolveOperationsProfile({ countries: ["de"] });
  const dispatcher = createDataExecutionDispatcher({ dataDir, state: new StateStore(dataDir), sql: options.sql, singleFlight, operationsPolicy, runHardlinks: applyOwnedGenerationHardlinks });
  const runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch });
  const receiver = createDataExecutionReceiver({ runtime, installation, configurationFence: fence, dispatcher, operationsPolicy });
  const app = Fastify(); let posts = 0, preparePosts = 0, settlePosts = 0;
  const maintenanceIds = new Set<string>();
  const maintenanceReplies: { status: number; error: unknown }[] = [];
  const settlementResponseStatuses:number[]=[];
  const fenceInspectionReplies: { status: number; body: unknown }[] = [];
  let originalInspection: { url: string; headers: Record<string, string> } | undefined;
  const keys = new Set<string>(), replies: { status: number; body: unknown }[] = [];
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "POST" && /^\/executions\/configuration-maintenance\/[a-f0-9-]{36}\/settle$/.test(request.url)) {settlePosts++;settlementResponseStatuses.push(reply.statusCode);}
    if (request.method === "GET" && request.url.startsWith("/executions/configuration-maintenance/")) {
      fenceInspectionReplies.push({ status: reply.statusCode, body: typeof payload === "string" ? JSON.parse(payload) : null });
      originalInspection = { url: request.url, headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string,string] => typeof entry[1] === "string")) };
    }
    if (request.method === "POST" && request.url === "/executions/configuration-maintenance/prepare") {
      const id = (request.body as { maintenanceId?: string } | undefined)?.maintenanceId;
      if (id) maintenanceIds.add(id);
      preparePosts++;
      maintenanceReplies.push({ status: reply.statusCode, error: typeof payload === "string" ? JSON.parse(payload).error : null });
      if (options.losePrepareResponse) reply.raw.destroy();
    }
    if (request.method === "POST" && request.url === "/executions/generation-hardlinks") {
      const key = (request.body as { operationKey?: string } | undefined)?.operationKey;
      if (key) keys.add(key);
      replies.push({ status: reply.statusCode, body: typeof payload === "string" ? JSON.parse(payload) : null });
      posts++; if (options.loseHardlinkResponse) reply.raw.destroy();
    }
    return payload;
  });
  const token = "synthetic-task012-data-manager-token";
  registerAuth(app, token, { executionReceiver: () => receiver });
  registerApi(app, { dataDir, singleFlight, operationsPolicy, executionReceiver: receiver });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const resumeHttp=async()=>{
    if(app.server.listening)return;
    const address=new URL(baseUrl);
    await new Promise<void>((resolve,reject)=>{
      app.server.once("error",reject);
      app.server.listen(Number(address.port),address.hostname,()=>{app.server.removeListener("error",reject);resolve();});
    });
  };
  const pauseHttp=async()=>{
    app.server.closeAllConnections();
    await new Promise<void>((resolve,reject)=>app.server.close(error=>error?reject(error):resolve()));
  };
  let stopped = false;
  const stopForRestart = async () => {
    if (stopped) return;
    await runtime.close(); app.server.closeAllConnections(); await app.close();
    for (const connection of uncertainConnections) connection.release();
    uncertainConnections.clear(); journal.close(); closeControlInstallation(installation); stopped = true;
  };
  return { baseUrl, token, store, receiver, pauseHttp, resumeHttp, get posts() { return posts; }, get preparePosts() { return preparePosts; }, get settlePosts() { return settlePosts; },
    get settlementSqlIo() { return { commits: settlementCommits, updates: settlementUpdates }; },
    get settlementContainmentIo() { return { rollbacks: settlementRollbacks, terminated: terminatedSettlementSession }; },
    get fenceInspections() { return structuredClone(fenceInspectionReplies); }, stopForRestart,
    get startupRecoveryRequired() { return startupRecoveryRequired; },
    assertDataAdmission: () => options.sql.begin(async tx => { await fence.assertAdmission({ unsafe: (query, parameters) => tx.unsafe(query, parameters) }); }),
    settlementCommitEntered: commitEntered.promise, releaseSettlementCommit: () => continueCommit.resolve(),
    async inspectWithOriginalWitness() {
      if (!originalInspection) throw Error("Original agent inspection request unavailable");
      const response = await fetch(baseUrl + originalInspection.url, { headers: originalInspection.headers });
      return { status: response.status, body: await response.json() };
    },
    get settlementResponseStatuses(){return [...settlementResponseStatuses];},
    get hardlinkResponseStatuses() { return replies.map(reply => reply.status); },
    get hardlinkResponses() { return structuredClone(replies); },
    reconcileRetention: () => reconcileControlRetention(installation, { maxFamilies: 64 }),
    async diagnostics() { return { maintenanceReplies, replies: replies.map(reply => ({ status: reply.status, error: (reply.body as { error?: unknown } | null)?.error })),
      executions: await Promise.all([...keys].map(async key => { const value = await store.lookup(key); return value && { status: value.status.status, publication: value.status.publication, diagnostics: value.status.diagnostics }; })) }; },
    async close() {
      await stopForRestart();
      // Exact fixture-owned execution IDs only; no broad job cleanup.
      for (const key of keys) await options.sql`DELETE FROM data_manager.jobs WHERE operation_key=${key}`;
      for (const id of maintenanceIds) await options.sql`DELETE FROM data_manager.jobs WHERE kind='configuration-maintenance' AND metadata->'configurationMaintenance'->'receipt'->>'maintenanceId'=${id}`;
    },
  };
}
