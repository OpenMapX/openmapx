/** Native owning DM assembly. Only exact pinned public CSV acquisition is fixture IO. */
import { createInterface } from "node:readline";

const lines = createInterface({ input: process.stdin });
const input = JSON.parse((await lines[Symbol.asyncIterator]().next()).value);
lines.close();
Object.assign(process.env, input.environment, {
  DATABASE_URL: input.databaseUrl,
  OPS_AGENT_URL: input.agentUrl,
  OPS_AGENT_TOKEN_FILE: input.tokenFile,
});
const fetchOriginal = globalThis.fetch;
globalThis.fetch = (url, options) =>
  /^https:\/\/raw\.githubusercontent\.com\/MobilityData\/gbfs\/[bc]{40}\/systems\.csv$/.test(
    String(url),
  )
    ? Promise.resolve(new Response(input.csv, { headers: { "content-type": "text/csv" } }))
    : fetchOriginal(url, options);
const [
  { openControlInstallation, createDataExecutionControlJournal },
  { rawSql, sql },
  { createDataConfigurationMaintenance },
  { createPostgresDataExecutionStore },
  { createDataExecutionRuntime },
  { createDataExecutionReceiver },
  { createDataExecutionDispatcher },
  { getSingleFlightController },
  { StateStore },
  { resolveOperationsProfileFromEnv },
  { registerAuth },
  { registerApi },
  { default: Fastify },
] = await Promise.all([
  import("@openmapx/core/build-artifacts"),
  import("../../src/db/index.ts"),
  import("../../src/jobs/execution/configuration-maintenance.ts"),
  import("../../src/jobs/execution/store.ts"),
  import("../../src/jobs/execution/runtime.ts"),
  import("../../src/jobs/execution/receiver.ts"),
  import("../../src/jobs/execution/dispatch.ts"),
  import("../../src/jobs/transitous/runtime.ts"),
  import("../../src/state.ts"),
  import("../../src/jobs/transitous/operations-profile.ts"),
  import("../../src/auth.ts"),
  import("../../src/api.ts"),
  import("fastify"),
]);
const installation = openControlInstallation({
  infraDir: input.infraDir,
  role: "data-manager",
  serviceIds: input.serviceIds,
});
const journal = createDataExecutionControlJournal(installation, rawSql);
const fence = createDataConfigurationMaintenance(rawSql, installation);
await fence.startup();
const store = createPostgresDataExecutionStore(rawSql, {
  controlJournal: journal,
  configurationFence: fence,
});
const policy = resolveOperationsProfileFromEnv(),
  singleFlight = getSingleFlightController();
const dispatcher = createDataExecutionDispatcher({
  dataDir: input.dataDir,
  state: new StateStore(input.dataDir),
  sql,
  singleFlight,
  operationsPolicy: policy,
  runHardlinks: async () => {
    throw Error("No generation in catalog fixture");
  },
});
const runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch });
const receiver = createDataExecutionReceiver({
  runtime,
  installation,
  configurationFence: fence,
  dispatcher,
  operationsPolicy: policy,
});
const app = Fastify();
registerAuth(app, input.token, { executionReceiver: () => receiver });
registerApi(app, {
  dataDir: input.dataDir,
  singleFlight,
  operationsPolicy: policy,
  executionReceiver: receiver,
});
await runtime.reconcile();
const url = await app.listen({ host: "127.0.0.1", port: input.listenPort ?? 0 });
process.stdout.write(JSON.stringify({ event: "ready", url }) + "\n");
