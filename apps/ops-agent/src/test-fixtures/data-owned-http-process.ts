import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  assertControlExecutionForward,
  closeControlInstallation,
  openControlInstallation,
  restoreAdmittedControlExecution,
} from "@openmapx/core/build-artifacts";
import { createDataTransitTrustedOpsDataSource } from "../data-transit-resource-source";
import { createDockerRuntime, runContainedProcess } from "../docker-runtime";
import { openOpsJobJournal } from "../journal";
import { createProductionRegistryResourceClaimer } from "../policy";
import { buildOpsAgentServer } from "../server";
import { createTransitousLockRuntime } from "../transitous-lock-runtime";
import { createFileTrustedOpsDataSource } from "../trusted-config-source";

const lines = createInterface({ input: process.stdin });
const messages = lines[Symbol.asyncIterator]();
const initial = await messages.next();
if (initial.done) throw Error("Missing fixed fixture startup");
const { root, token, validationFailure, crash, loseCancelResponse } = JSON.parse(initial.value) as {
  root: string;
  token: string;
  validationFailure?: boolean | "twice";
  crash?: "before-proof" | "before-terminal" | "after-terminal";
  loseCancelResponse?: boolean;
};
const installation = openControlInstallation({
  infraDir: root,
  role: "ops-agent",
  serviceIds: ["motis", "motis-feed-proxy"],
});
const journal = await openOpsJobJournal(join(root, "data/ops-agent/jobs-v1.json"));
const replace = journal.replace.bind(journal);
journal.replace = async (records) => {
  const terminal = records.some(
    (record) =>
      record.operation.kind === "feedProxy.validateAndReload" &&
      record.state === "failed" &&
      record.errorClass === "runtime",
  );
  if (terminal && crash === "before-terminal") process.exit(86);
  await replace(records);
  if (terminal && crash === "after-terminal") process.exit(86);
};
let release = () => {};
const held = new Promise<void>((resolve) => {
  release = resolve;
});
let effects = 0;
let validations = 0;
const send = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
const runtime = createDockerRuntime({
  stack: {
    infraDir: root,
    composePath: join(root, "compose.yml"),
    composeReleasePath: join(root, "release.yml"),
  },
  fileExists: existsSync,
  // Only external Docker I/O is substituted. Production handlers, admission,
  // journal, HTTP auth, delegation and cancellation run in this process.
  execFile: async (_file, args, options) => {
    if (args[2] === "/bin/sh") {
      validations++;
      const invalid = validationFailure && (validations === 1 || validationFailure === "twice");
      if (invalid) send({ type: "validation-failed" });
      const bin = join(root, "fixture-bin");
      mkdirSync(bin, { recursive: true });
      writeFileSync(join(bin, "nginx"), `#!/bin/sh\nexit ${invalid ? 1 : 0}\n`, { mode: 0o700 });
      const completed = await runContainedProcess(
        "/bin/sh",
        [
          "-c",
          'PATH="$1:$PATH"; export PATH; shift; exec "$@"',
          "fixed-docker-substitute",
          bin,
          ...args.slice(2),
        ],
        options,
      );
      if (crash === "before-proof") process.exit(86);
      return completed;
    }
    const isPromotion = args.includes("--force-recreate"),
      isReload = args.includes("reload");
    if (isPromotion || isReload || (args[0] === "restart" && args[1] === "motis")) {
      effects++;
      send({ type: "effect", effects });
      const aborted = () => send({ type: "aborted" });
      options.signal.addEventListener("abort", aborted, { once: true });
      if (options.signal.aborted) aborted();
      try {
        await held;
      } finally {
        options.signal.removeEventListener("abort", aborted);
      }
    }
    return { stdout: "", stderr: "" };
  },
});
createTransitousLockRuntime(runtime, { rootDir: root });
const app = buildOpsAgentServer({
  runtime,
  journal,
  controlInstallation: installation,
  tokens: { api: "a".repeat(43), "data-manager": token },
  resourceClaimer: createProductionRegistryResourceClaimer({
    services: ["motis", "motis-feed-proxy"].map((serviceId) => ({
      serviceId,
      enabled: true,
      isBuiltIn: true,
    })),
    integrationIds: [],
    trustedData: createDataTransitTrustedOpsDataSource(
      installation,
      createFileTrustedOpsDataSource({
        directory: join(root, "trusted-config"),
        token: "a".repeat(43),
        allowedUids: [process.getuid!()],
        expectedGid: process.getgid!(),
      }),
    ),
  }),
});
let cancels = 0;
if (loseCancelResponse)
  app.addHook("onSend", async (request, reply, payload) => {
    if (request.method === "DELETE") {
      cancels++;
      send({ type: "cancel-response", cancels });
      if (cancels === 1) reply.raw.destroy();
    }
    return payload;
  });
await app.listen({ host: "127.0.0.1", port: 0 });
const address = app.server.address();
if (!address || typeof address === "string") throw Error("Missing actual agent address");
send({ type: "ready", port: address.port });
try {
  for await (const line of { [Symbol.asyncIterator]: () => messages }) {
    const command = JSON.parse(line) as { type: string };
    if (command.type === "release") release();
    if (command.type === "probe") {
      const record = journal.records()[0];
      if (!record?.operationFingerprint || !record.deadlineAt)
        throw Error("Missing original admission");
      const authority = restoreAdmittedControlExecution(installation, {
        executor: "ops-agent",
        principal: "data-manager",
        executionId: record.operationId,
        operationKey: record.operationKey,
        operationFingerprint: record.operationFingerprint,
        fingerprint: record.fingerprint,
        deadlineAt: record.deadlineAt,
      });
      let forward = true;
      try {
        assertControlExecutionForward(authority);
      } catch {
        forward = false;
      }
      send({
        type: "probe",
        forward,
        effects,
        operationId: record.operationId,
        state: record.state,
        terminalAt: record.terminalAt ?? null,
      });
    }
    if (command.type === "close") break;
  }
} finally {
  release();
  await app.close();
  closeControlInstallation(installation);
  lines.close();
  process.stdin.destroy();
}
