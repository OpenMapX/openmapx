import { join } from "node:path";
import { closeControlInstallation, createDataExecutionControlJournal, openControlInstallation, pruneControlRecords } from "@openmapx/core/build-artifacts";
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
import { removePrunedDataRows } from "../../../../services/data-manager/src/jobs/execution/prune-rows";
import { createPostgresDataExecutionStore } from "../../../../services/data-manager/src/jobs/execution/store";

/** Actual HTTP receiver, SQL admission guard, dispatcher, filesystem leaf and journal. */
export async function ownedDataManager(options: {
  sql: Parameters<typeof createPostgresDataExecutionStore>[0]; infraDir: string; serviceIds: string[]; loseHardlinkResponse?: boolean;
  /** Drops the first prepare reply; the agent repeats the same body. */
  losePrepareResponseOnce?: boolean;
  pausePrepareResponse?: boolean;
  /** Drops the first successful settle reply after the row was settled. */
  loseSettleResponseOnce?: boolean;
  /** Answers every settle with 503 while it returns true, before anything is settled. */
  refuseSettles?: () => boolean;
  /** Called once the fence has been prepared successfully. */
  onPrepared?: () => void;
}) {
  const prepareReplyEntered = Promise.withResolvers<void>(), continuePrepareReply = Promise.withResolvers<void>();
  const installation = openControlInstallation({ infraDir: options.infraDir, role: "data-manager", serviceIds: options.serviceIds });
  const dataDir = join(options.infraDir, "data"), journal = createDataExecutionControlJournal(installation, options.sql);
  const fence = createDataConfigurationMaintenance(options.sql, installation);
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
  app.addHook("onRequest", async (request, reply) => {
    if (options.refuseSettles?.() && request.method === "POST" && /^\/executions\/configuration-maintenance\/[a-f0-9-]{36}\/settle$/.test(request.url)) await reply.code(503).send({ error: "unavailable" });
  });
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "POST" && /^\/executions\/configuration-maintenance\/[a-f0-9-]{36}\/settle$/.test(request.url)) {settlePosts++;settlementResponseStatuses.push(reply.statusCode);if(options.loseSettleResponseOnce&&reply.statusCode===200&&settlementResponseStatuses.filter(status=>status===200).length===1)reply.raw.destroy();}
    if (request.method === "GET" && request.url.startsWith("/executions/configuration-maintenance/")) {
      fenceInspectionReplies.push({ status: reply.statusCode, body: typeof payload === "string" ? JSON.parse(payload) : null });
      originalInspection = { url: request.url, headers: Object.fromEntries(Object.entries(request.headers).filter((entry): entry is [string,string] => typeof entry[1] === "string")) };
    }
    if (request.method === "POST" && request.url === "/executions/configuration-maintenance/prepare") {
      const id = (request.body as { maintenanceId?: string } | undefined)?.maintenanceId;
      if (id) maintenanceIds.add(id);
      preparePosts++;
      maintenanceReplies.push({ status: reply.statusCode, error: typeof payload === "string" ? JSON.parse(payload).error : null });
      if (reply.statusCode === 200) options.onPrepared?.();
      if (options.pausePrepareResponse && reply.statusCode === 200) { prepareReplyEntered.resolve(); await continuePrepareReply.promise; }
      if (options.losePrepareResponseOnce && preparePosts === 1) reply.raw.destroy();
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
  // The operations agent's own token; the API's and host CLI's differ.
  registerAuth(
    app,
    { api: `${token}-api`, "ops-agent": token, "host-cli": `${token}-cli` }
  );
  registerApi(app, { dataDir, operationsPolicy, executionReceiver: receiver });
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
    continuePrepareReply.resolve();
    await runtime.close(); app.server.closeAllConnections(); await app.close();
    closeControlInstallation(installation); stopped = true;
  };
  return { baseUrl, token, store, receiver, pauseHttp, resumeHttp, get posts() { return posts; }, get preparePosts() { return preparePosts; }, get settlePosts() { return settlePosts; },
    prepareReplyEntered: prepareReplyEntered.promise, releasePrepareResponse: () => continuePrepareReply.resolve(),
    get fenceInspections() { return structuredClone(fenceInspectionReplies); }, stopForRestart,
    get startupRecoveryRequired() { return startupRecoveryRequired; },
    assertDataAdmission: () => options.sql.begin(async tx => { await fence.assertAdmission({ unsafe: (query, parameters) => tx.unsafe(query, parameters) }); }),
    async inspectWithOriginalWitness() {
      if (!originalInspection) throw Error("Original agent inspection request unavailable");
      const response = await fetch(baseUrl + originalInspection.url, { headers: originalInspection.headers });
      return { status: response.status, body: await response.json() };
    },
    get settlementResponseStatuses(){return [...settlementResponseStatuses];},
    /** States of the fences this fixture prepared. */
    async fenceStates() {
      const ids = [...maintenanceIds];
      if (!ids.length) return [];
      return (await options.sql`SELECT state FROM data_manager.configuration_fence WHERE maintenance_id = ANY(${ids}::uuid[]) ORDER BY prepared_at`).map(row => row.state as string);
    },
    get hardlinkResponseStatuses() { return replies.map(reply => reply.status); },
    get hardlinkResponses() { return structuredClone(replies); },
    /** One prune pass as the service runs it, at the given time. */
    pruneRecords: (now?: number) =>
      pruneControlRecords(installation, {
        now,
        beforeRemove: (keys) => removePrunedDataRows(options.sql, keys),
      }),
    async diagnostics() { return { maintenanceReplies, replies: replies.map(reply => ({ status: reply.status, error: (reply.body as { error?: unknown } | null)?.error })),
      executions: await Promise.all([...keys].map(async key => { const value = await store.lookup(key); return value && { status: value.status.status, publication: value.status.publication, diagnostics: value.status.diagnostics }; })) }; },
    async close() {
      await stopForRestart();
      // Exact fixture-owned execution IDs only; no broad job cleanup.
      for (const key of keys) await options.sql`DELETE FROM data_manager.jobs WHERE operation_key=${key}`;
      for (const id of maintenanceIds) await options.sql`DELETE FROM data_manager.configuration_fence WHERE maintenance_id=${id}::uuid`;
    },
  };
}
