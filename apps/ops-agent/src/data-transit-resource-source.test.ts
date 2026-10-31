import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  canonicalJson,
  createControlRootOperationKey,
  type ExecutionRef,
  executionFingerprint,
  OpsClient,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { expect, it } from "vitest";
import { applyHardlinkPlan } from "../../../packages/hardlinks/src/index";
import { createDataTransitTrustedOpsDataSource } from "./data-transit-resource-source";
import { createDockerRuntime, runContainedProcess } from "./docker-runtime";
import { openOpsJobJournal } from "./journal";
import { createProductionRegistryResourceClaimer } from "./policy";
import { buildOpsAgentServer } from "./server";

async function fixture(
  replaceAfterValidation = false,
  admissionPolicy?: "stricter" | "late",
  fault?: "validation" | "transport" | "reload" | "marker",
) {
  const root = mkdtempSync(join(tmpdir(), "omx-real-candidate-policy-")),
    data = join(root, "data"),
    proxy = join(data, "motis-feed-proxy");
  mkdirSync(join(proxy, "conf"), { recursive: true });
  writeFileSync(join(proxy, "conf/default.conf"), "server { listen 80; }\n");
  writeFileSync(join(proxy, "feed-proxy-vars.json"), "{}\n");
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
  await control.provisionControlInstallation(root);
  const dm = control.openControlInstallation({
      infraDir: root,
      role: "data-manager",
      serviceIds: ["motis-feed-proxy"],
    }),
    agent = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis-feed-proxy"],
    }),
    deadlineAt = Date.now() + 60000,
    input = { kind: "transit-sync", countries: ["de"] },
    bodyHash = createHash("sha256").update(canonicalJson(input)).digest("hex"),
    key = createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
    parent: ExecutionRef = {
      executor: "data-manager",
      principal: "data-manager",
      executionId: randomUUID(),
      operationKey: key,
      operationFingerprint: bodyHash,
      deadlineAt,
      fingerprint: executionFingerprint({
        kind: input.kind,
        operationFingerprint: bodyHash,
        deadlineAt,
      }),
    },
    phase = "proxy-stage" as const,
    operation = {
      kind: "feedProxy.validateAndReload" as const,
      candidateId: "ctrl-" + "a".repeat(32),
    },
    slot: control.ControlChildReservation = {
      version: 1,
      phase,
      ordinal: 0,
      kind: operation.kind,
      recipient: "ops-agent",
      serviceIds: ["motis-feed-proxy"],
      operationFingerprint: opsOperationFingerprint(operation),
      execution: {
        executor: "ops-agent",
        principal: "data-manager",
        executionId: `job1_${randomUUID().replaceAll("-", "")}`,
        operationKey: control.controlChildOperationKey(key, phase, 0),
      },
    };
  // The candidate identifier is fixed by the original root, before any grant.
  operation.candidateId = `ctrl-${createHash("sha256").update(`openmapx-transit-candidate-v1\0${key}\0${phase}\0${0}`).digest("hex").slice(0, 32)}`;
  slot.operationFingerprint = opsOperationFingerprint(operation);
  const authority = control.retainAdmittedControlExecution(dm, {
      execution: parent,
      kind: input.kind,
      operation: input,
      admittedAt: Date.now(),
      requestedDeadlineAt: deadlineAt,
      serviceIds: ["motis-feed-proxy"],
      reservations: [slot],
    }),
    lease = await control.acquireArtifactTargetLease({
      dataRoot: data,
      serviceIds: ["motis-feed-proxy"],
      owner: authority,
    });
  control.retainOwnedDataTransitCandidate(authority, slot);
  const bound = await control.bindControlChildPhase(authority, slot),
    issued = await control.issueControlChildPhase(authority, {
      ...slot,
      lease,
      childPublicKey: agent.publicKey,
    });
  const claimer = createProductionRegistryResourceClaimer({
    services: [{ serviceId: "motis-feed-proxy", isBuiltIn: true, enabled: true }],
    integrationIds: [],
    trustedData: createDataTransitTrustedOpsDataSource(agent, { claim: async () => null }),
  });
  let calls = 0;
  const runtime = createDockerRuntime({
      stack: {
        infraDir: root,
        composePath: join(root, "compose.yml"),
        composeReleasePath: join(root, "release.yml"),
      },
      fileExists: () => false,
      execFile: async (_file, args, options) => {
        calls++;
        if (args[2] === "/bin/sh") {
          const bin = join(root, "fixture-bin");
          mkdirSync(bin, { recursive: true });
          writeFileSync(join(bin, "nginx"), `#!/bin/sh\nexit ${fault === "validation" ? 1 : 0}\n`, {
            mode: 0o700,
          });
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
          if (replaceAfterValidation)
            writeFileSync(join(proxy, "conf/default.conf"), "replaced after the resource claim\n");
          if (fault === "transport") throw Error("Lost Docker transport after validation");
          if (fault === "marker")
            return { ...completed, stdout: completed.stdout.replace(/:[0-9]+\n$/, ":256\n") };
          return completed;
        }
        if (fault === "reload" && args.includes("reload")) throw Error("Lost reload completion");
        return { stdout: "", stderr: "" };
      },
    }),
    journal = await openOpsJobJournal(coreServices.agentStatePaths(root).journal),
    token = "b".repeat(43),
    tokenFile = join(root, "token");
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const app = buildOpsAgentServer({
    runtime,
    journal,
    ...(admissionPolicy === "stricter" ? { operationTimeoutMs: 1000 } : {}),
    ...(admissionPolicy === "late" ? { now: () => new Date(Date.now() + 120000) } : {}),
    controlInstallation: agent,
    resourceClaimer: claimer,
    tokens: { api: "a".repeat(43), "data-manager": token },
  });
  await app.listen({ host: "127.0.0.1", port: 0 });
  const address = app.server.address();
  if (!address || typeof address === "string") throw Error("Missing actual agent address");
  const client = new OpsClient({ baseUrl: `http://127.0.0.1:${address.port}`, tokenFile }),
    published = join(
      data,
      ".admin-target-control/executions/data-manager",
      `${slot.execution.operationKey}.data-candidate.json`,
    );
  return {
    root,
    data,
    proxy,
    dm,
    agent,
    authority,
    lease,
    parent,
    operation,
    slot,
    bound,
    issued,
    claimer,
    published,
    client,
    calls: () => calls,
    async close() {
      await app.close();
      control.closeArtifactTargetLeaseHandle(lease);
      control.closeControlInstallation(agent);
      control.closeControlInstallation(dm);
      rmSync(root, { recursive: true, force: true });
    },
  };
}
it.each(["validation", "validation-replaced", "transport", "reload", "marker"] as const)(
  "retains only the exact actual %s validation proof",
  async (fault) => {
    const f = await fixture(
      fault === "validation-replaced",
      undefined,
      fault === "validation-replaced" ? "validation" : fault,
    );
    try {
      control.consumeControlChildDispatch(f.issued.dispatchTicket);
      const accepted = await f.client.execute(f.operation, {
        operationKey: f.slot.execution.operationKey,
        execution: { requestedDeadlineAt: f.bound.execution.deadlineAt },
        controlAssertion: f.issued.assertion,
      });
      if (accepted.execution !== "async") throw Error("Expected actual agent admission");
      await expect
        .poll(async () => (await f.client.status(f.operation.kind, accepted.operationId)).state, {
          timeout: 15000,
        })
        .toBe("failed");
      const authority = control.restoreAdmittedControlExecution(f.agent, f.bound.execution);
      if (fault === "validation") {
        await expect
          .poll(
            () => control.inspectArtifactTargetLeaseChildSettlement(f.lease, f.bound.execution),
            { timeout: 15000 },
          )
          .toMatchObject({ outcome: "contained", publication: "not_started" });
        expect(control.inspectFeedProxyValidationFailure(authority)).toMatch(/^[a-f0-9]{64}$/);
        await expect
          .poll(
            () => control.verifyFeedProxyCanonicalTerminal(f.authority, f.bound.execution).state,
            { timeout: 15000 },
          )
          .toBe("failed");
        const raw = JSON.parse(
          readFileSync(
            join(
              f.root,
              "control-private/ops-agent/observations",
              `proxy-validation-${f.bound.execution.operationKey}.json`,
            ),
            "utf8",
          ),
        );
        const input = {
          candidateDigest: raw.payload.candidateDigest,
          validationExitCode: raw.payload.validationExitCode,
          completionDigest: raw.payload.completionDigest,
        };
        // An original failed invocation remains known after a later legitimate
        // restore replaces the active bytes. Observation grants no new effect.
        writeFileSync(join(f.proxy, "conf/default.conf"), "restored previous proxy bytes\n");
        expect(() => control.commitFeedProxyValidationFailure(authority, input)).not.toThrow();
        expect(() =>
          control.commitFeedProxyValidationFailure(authority, { ...input, validationExitCode: 2 }),
        ).toThrow();
        expect(() => control.markFeedProxyReloadAttempted(authority)).toThrow();
        const status = await f.client.status(f.operation.kind, accepted.operationId);
        const terminal = JSON.parse(
          readFileSync(
            join(
              f.root,
              "control-private/ops-agent/observations",
              `terminal-${f.bound.execution.operationKey}.json`,
            ),
            "utf8",
          ),
        );
        expect(() =>
          control.repairControlJournalTerminal(
            f.agent,
            f.bound.execution,
            status,
            terminal.payload.terminalAt,
          ),
        ).not.toThrow();
        expect(() =>
          control.repairControlJournalTerminal(
            f.agent,
            f.bound.execution,
            status,
            terminal.payload.terminalAt + 1,
          ),
        ).toThrow();
        raw.signature = "a".repeat(86);
        writeFileSync(
          join(
            f.root,
            "control-private/ops-agent/observations",
            `proxy-validation-${f.bound.execution.operationKey}.json`,
          ),
          JSON.stringify(raw),
          { mode: 0o600 },
        );
        expect(() =>
          control.repairControlJournalTerminal(
            f.agent,
            f.bound.execution,
            status,
            terminal.payload.terminalAt,
          ),
        ).toThrow();
      } else {
        expect(
          control.inspectArtifactTargetLeaseChildSettlement(f.lease, f.bound.execution),
        ).toBeNull();
        expect(control.inspectFeedProxyValidationFailure(authority)).toBeNull();
        expect(() =>
          control.commitFeedProxyValidationFailure(authority, {
            candidateDigest: "a".repeat(64),
            validationExitCode: 1,
            completionDigest: "b".repeat(64),
          }),
        ).toThrow();
      }
      expect(f.calls()).toBe(fault === "reload" ? 2 : 1);
    } finally {
      await f.close();
    }
  },
  30000,
);
it("accepts the production hardlinked proxy candidate through validation and reload", async () => {
  const f = await fixture();
  try {
    control.consumeControlChildDispatch(f.issued.dispatchTicket);
    const accepted = await f.client.execute(f.operation, {
      operationKey: f.slot.execution.operationKey,
      execution: { requestedDeadlineAt: f.bound.execution.deadlineAt },
      controlAssertion: f.issued.assertion,
    });
    if (accepted.execution !== "async") throw Error("Expected actual agent admission");
    await expect
      .poll(async () => (await f.client.status(f.operation.kind, accepted.operationId)).state, {
        timeout: 15000,
      })
      .toBe("succeeded");
    expect(f.calls()).toBe(2);
  } finally {
    await f.close();
  }
}, 30000);
it.each([
  "missing",
  "forged",
  "foreign-root",
  "foreign-phase",
  "foreign-body",
  "foreign-target",
  "foreign-origin",
  "inode",
  "bytes",
  "directory",
  "consumer-inode",
  "consumer-symlink",
  "canceled",
] as const)(
  "rejects %s provenance through the actual production registry before Docker effects",
  async (mode) => {
    const f = await fixture();
    try {
      let key = f.slot.execution.operationKey,
        operation = f.operation;
      if (mode === "missing") rmSync(f.published);
      if (mode === "forged" || mode === "foreign-target" || mode === "foreign-origin") {
        const raw = JSON.parse(readFileSync(f.published, "utf8"));
        if (mode === "forged") raw.signature = "a".repeat(86);
        else if (mode === "foreign-target") raw.payload.serviceIds = ["motis"];
        else raw.payload.origin.notAfter++;
        writeFileSync(f.published, JSON.stringify(raw), { mode: 0o600 });
      }
      if (mode === "foreign-root" || mode === "foreign-phase") {
        key = control.controlChildOperationKey(
          mode === "foreign-root"
            ? createControlRootOperationKey({
                notAfter: f.parent.deadlineAt,
                nonce: randomBytes(16),
              })
            : f.parent.operationKey,
          mode === "foreign-phase" ? "proxy-commit" : "proxy-stage",
          0,
        );
        copyFileSync(
          f.published,
          join(
            f.data,
            ".admin-target-control/executions/data-manager",
            `${key}.data-candidate.json`,
          ),
        );
      }
      if (mode === "foreign-body")
        operation = { ...operation, candidateId: "ctrl-" + "b".repeat(32) };
      if (mode === "inode") {
        const path = join(f.proxy, "conf/default.conf"),
          bytes = readFileSync(path);
        renameSync(path, `${path}.original`);
        writeFileSync(path, bytes);
      }
      if (mode === "bytes")
        writeFileSync(join(f.proxy, "feed-proxy-vars.json"), '{"foreign":true}\n');
      if (mode === "directory") {
        renameSync(f.proxy, `${f.proxy}.original`);
        mkdirSync(join(f.proxy, "conf"), { recursive: true });
        writeFileSync(join(f.proxy, "conf/default.conf"), "server { listen 80; }\n");
        writeFileSync(join(f.proxy, "feed-proxy-vars.json"), "{}\n");
      }
      if (mode === "consumer-inode" || mode === "consumer-symlink") {
        const path = join(f.proxy, "motis-feed-proxy-config/default.conf"),
          bytes = readFileSync(path);
        rmSync(path);
        if (mode === "consumer-inode") writeFileSync(path, bytes);
        else (await import("node:fs")).symlinkSync(join(f.proxy, "conf/default.conf"), path);
      }
      if (mode === "canceled") {
        control.cancelControlExecution(f.authority);
        await control.cancelArtifactTargetLease(f.lease);
      }
      if (mode !== "canceled")
        expect(
          await f.claimer.claim(
            operation,
            opsOperationFingerprint(operation),
            new AbortController().signal,
            { role: "data-manager", operationKey: key },
          ),
        ).toBeNull();
      if (mode === "canceled")
        expect(() => control.consumeControlChildDispatch(f.issued.dispatchTicket)).toThrow(
          /fenced|cancel/i,
        );
      else control.consumeControlChildDispatch(f.issued.dispatchTicket);
      await expect(
        f.client.execute(operation, {
          operationKey: key,
          execution: { requestedDeadlineAt: f.bound.execution.deadlineAt },
          controlAssertion: f.issued.assertion,
        }),
      ).rejects.toThrow();
      expect(f.calls()).toBe(0);
    } finally {
      await f.close();
    }
  },
  30000,
);
it("rechecks the retained snapshot after nginx validation and before reload", async () => {
  const f = await fixture(true);
  try {
    control.consumeControlChildDispatch(f.issued.dispatchTicket);
    const accepted = await f.client.execute(f.operation, {
      operationKey: f.slot.execution.operationKey,
      execution: { requestedDeadlineAt: f.bound.execution.deadlineAt },
      controlAssertion: f.issued.assertion,
    });
    if (accepted.execution !== "async") throw Error("Expected actual asynchronous agent admission");
    await expect
      .poll(async () => (await f.client.status(f.operation.kind, accepted.operationId)).state)
      .toBe("failed");
    expect(f.calls()).toBe(1);
  } finally {
    await f.close();
  }
}, 30000);

it.each(["stricter", "late"] as const)(
  "retains the bound identity when the actual recipient is %s",
  async (policy) => {
    const f = await fixture(false, policy);
    try {
      const original = f.bound.execution;
      control.consumeControlChildDispatch(f.issued.dispatchTicket);
      await expect(
        f.client.execute(f.operation, {
          operationKey: original.operationKey,
          execution: { requestedDeadlineAt: original.deadlineAt },
          controlAssertion: f.issued.assertion,
        }),
      ).rejects.toThrow();
      expect(f.calls()).toBe(0);
      expect(control.lookupControlChildPhase(f.authority, f.slot)?.execution).toEqual(original);
    } finally {
      await f.close();
    }
  },
  30000,
);
