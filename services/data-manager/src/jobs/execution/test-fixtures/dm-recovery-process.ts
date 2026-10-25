import { join } from "node:path";
import { createInterface } from "node:readline";
import * as control from "@openmapx/core/build-artifacts";
import Fastify from "fastify";
import { registerApi } from "../../../api.js";
import { registerAuth } from "../../../auth.js";
import { db, rawSql } from "../../../db/index.js";
import { StateStore } from "../../../state.js";
import { resolveOperationsProfile } from "../../transitous/operations-profile.js";
import { createDefaultTransitousScriptRunner } from "../../transitous/script-runner.js";
import { createSingleFlightController } from "../../transitous/single-flight.js";
import { installDataMutationAdmission } from "../admission.js";
import { createDataConfigurationMaintenance } from "../configuration-maintenance.js";
import { createDataExecutionDispatcher } from "../dispatch.js";
import { createDataExecutionReceiver } from "../receiver.js";
import { createDataExecutionRuntime } from "../runtime.js";
import { createPostgresDataExecutionStore } from "../store.js";

// Host mode uses the production maintenance dispatcher. Python mode isolates
// the actual owned script producer, so SIGKILL lands during its remote process.
// Admission, PostgreSQL, retained authority and HTTP cancellation are real.
const lines = createInterface({ input: process.stdin });
const messages = lines[Symbol.asyncIterator]();
const initial = await messages.next();
if (initial.done) throw Error("Missing fixture startup");
const { root, token, mode, replacement } = JSON.parse(initial.value) as {
  root: string;
  token: string;
  mode: "agent" | "python";
  replacement: boolean;
};
const installation = control.openControlInstallation({
  infraDir: root,
  role: "data-manager",
  serviceIds: ["data-manager", "motis", "motis-staging", "motis-feed-proxy"],
});
const fence = createDataConfigurationMaintenance(rawSql, installation);
await fence.startup();
installDataMutationAdmission(fence);
const journal = control.createDataExecutionControlJournal(installation, rawSql);
const store = createPostgresDataExecutionStore(rawSql, {
  controlJournal: journal,
  configurationFence: fence,
});
const singleFlight = createSingleFlightController({ db, admissionSql: rawSql });
const policy = resolveOperationsProfile({ countries: ["de"] });
const dispatcher = createDataExecutionDispatcher({
  dataDir: join(root, "data"),
  state: new StateStore(join(root, "data")),
  sql: rawSql,
  singleFlight,
  operationsPolicy: policy,
  runHardlinks: async () => {
    throw Error("No hardlinks in this fixture");
  },
});
const runner = createDefaultTransitousScriptRunner();
let dispatches = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const runtime = createDataExecutionRuntime({
  store,
  dispatch: async (input, context) => {
    dispatches++;
    send({ type: "dispatch", dispatches, id: context.execution.executionId });
    if (replacement) throw Error("Recovery must never redispatch");
    if (mode === "agent") return dispatcher.dispatch(input, context);
    if (input.kind !== "transit-sync") throw Error("Fixture selects transit only");
    await runner({ script: "garbage-collect" });
    context.signal.throwIfAborted();
    return {
      kind: input.kind,
      finalStatus: "ok",
      countries: input.countries,
      sourceRevision: "public-fixture",
    };
  },
});
const receiver = createDataExecutionReceiver({
  runtime,
  installation,
  configurationFence: fence,
  dispatcher,
  operationsPolicy: policy,
});
await runtime.reconcile();
const app = Fastify();
registerAuth(app, token, { executionReceiver: () => receiver });
registerApi(app, {
  dataDir: join(root, "data"),
  singleFlight,
  operationsPolicy: policy,
  executionReceiver: receiver,
  searchIndexSql: rawSql,
});
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw Error("Missing DM endpoint");
send({ type: "ready", port: address.port });
for await (const line of { [Symbol.asyncIterator]: () => messages }) {
  const command = JSON.parse(line) as { type: string };
  if (command.type === "probe") send({ type: "probe", dispatches });
  if (command.type === "reconcile") {
    await runtime.reconcile();
    send({ type: "reconciled" });
  }
}
