import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  closeControlInstallation,
  openControlInstallation,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
import {
  configurationPayloadDigest,
  type OpsOperation,
  opsOperationFingerprint,
  opsOperationSchema,
  prepareConfigurationCandidate,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueApiJobChildAssertion,
  prepareApiJobChildAttempt,
  prepareApiJobRoot,
} from "../../api/src/services/admin-job-parent";
import type { JobContext } from "../../api/src/services/job-runner";
import { installConfigurationRuntimeFixture as installTrustedConfigurationRuntime } from "./__fixtures__/configuration-runtime";
import { configurationSource } from "./__fixtures__/configuration-source";
import { testExecution } from "./__fixtures__/execution";
import { configurationPayloadSource } from "./data-transit-resource-source";
import type { PersistedOpsJob } from "./journal";
import { createRegistryResourceClaimer } from "./policy";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { buildOpsAgentServer } from "./server";
import type { TrustedConfigurationRuntimeOptions } from "./trusted-config-runtime";

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("transaction barrier timed out")), 3_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
const revision = (letter: string) => `cfg1_${letter.repeat(43)}`;
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-ownership-"));
  roots.push(root);
  const infraDir = join(root, "infra/docker");
  mkdirSync(infraDir, { recursive: true, mode: 0o700 });
  // The whole checkout at the agent's path, as earlier releases mounted it.
  mkdirSync(join(root, "services"), { mode: 0o755 });
  // The deployment's user, which only a host render writes into .env.
  writeFileSync(
    join(infraDir, ".env"),
    `UID=${process.geteuid?.() ?? 0}\nGID=${process.getegid?.() ?? 0}\n`,
    { mode: 0o600 },
  );
  const selection = coreServices.serviceSelectionPath(infraDir);
  mkdirSync(dirname(selection), { recursive: true, mode: 0o700 });
  writeFileSync(selection, '{"selected":["alpha"]}', { mode: 0o600 });
  const services: coreServices.LoadedService[] = [
    {
      manifest: {
        id: "alpha",
        name: "Alpha",
        version: "1.0.0",
        quality: "built-in",
        container: { image: "example/alpha", tag: "1" },
        configSchema: { properties: { label: { type: "string" } } },
      },
      directory: join(root, "services/alpha"),
      isBuiltIn: true,
      enabled: true,
    },
  ];
  const apply = async (
    letter: string,
    expected?: string | null,
    hooks: Partial<TrustedConfigurationRuntimeOptions> = {},
  ) => {
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services,
      integrationSchemas: new Map(),
      infraDir,
      env: {},
      ...hooks,
    });
    const operation = {
      ...(await configurationSource(runtime, infraDir)),
      expectedCurrentRevisionId: coreServices.currentConfigurationGeneration(infraDir),
      kind: "stack.render",
      revisionId: revision(letter),
      payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      ...(expected !== undefined ? { expectedCurrentRevisionId: expected } : {}),
    } as OpsOperation & { kind: "stack.render" };
    return dispatchOpsOperation(runtime, operation, {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog() {},
      claim: {
        operation,
        fingerprint: opsOperationFingerprint(operation),
        source: "trusted-data",
        capability: {
          revisionId: operation.revisionId,
          values: {},
          trustedConfiguration: {
            domain: `${letter}.example.test`,
            serviceConfigs: [{ serviceId: "alpha", values: { label: letter } }],
            integrationConfigs: [],
            serviceSecrets: [],
          },
        },
      },
    });
  };
  const label = () =>
    coreServices.readAppliedConfiguration(infraDir).serviceConfigs[0]?.values.label;
  const followUp = () =>
    readFileSync(join(infraDir, "state/ops-agent/traefik/dynamic/generated-routes.yml"), "utf8");
  return { root, infraDir, services, apply, label, followUp };
}
describe("trusted configuration ownership and outcomes", () => {
  it.each([
    "stack.render",
    "serviceSelection.apply",
    "serviceConfig.apply",
    "integrationConfig.apply",
    "vault.apply",
  ] as const)(
    "rejects a captured %s payload after a completed writer before any desired-selection effect",
    async (kind) => {
      const f = fixture();
      await f.apply("a");
      const capturedRevision = coreServices.currentConfigurationGeneration(f.infraDir);
      const capturedPayload = {
        domain: "a.example.test",
        serviceConfigs: [{ serviceId: "alpha", values: { label: "a" } }],
        integrationConfigs: [{ integrationId: "demo", values: {} }],
        serviceSecrets: [{ serviceId: "alpha", values: {} }],
        ...(kind === "serviceSelection.apply" ? { selectedRoots: [] } : {}),
      };
      let release!: () => void;
      const barrier = new Promise<void>((resolve) => {
        release = resolve;
      });
      const pending = (async () => {
        await barrier;
        const runtime = createUnavailableRuntime();
        installTrustedConfigurationRuntime(runtime, {
          services: f.services,
          integrationSchemas: new Map([["demo", {}]]),
          infraDir: f.infraDir,
          env: {},
        });
        const operation = {
          ...(await configurationSource(runtime, f.infraDir)),
          kind,
          revisionId: revision("c"),
          payloadDigest: configurationPayloadDigest(capturedPayload),
          expectedCurrentRevisionId: capturedRevision,
          ...(kind === "serviceConfig.apply" || kind === "vault.apply"
            ? { serviceId: "alpha" }
            : {}),
          ...(kind === "integrationConfig.apply" ? { integrationId: "demo" } : {}),
        } as OpsOperation;
        return dispatchOpsOperation(runtime, operation, {
          execution: testExecution(),
          signal: new AbortController().signal,
          emitLog() {},
          claim: {
            operation,
            fingerprint: opsOperationFingerprint(operation),
            source: "trusted-data",
            capability: {
              revisionId: revision("c"),
              values: {},
              trustedConfiguration: capturedPayload,
            },
          },
        });
      })();
      await f.apply("b");
      release();
      expect(await pending).toMatchObject({
        outcome: "not_committed",
        reason: "conflict",
        currentRevisionId: revision("b"),
      });
      expect(f.label()).toBe("b");
      expect(
        JSON.parse(readFileSync(coreServices.serviceSelectionPath(f.infraDir), "utf8")),
      ).toEqual({ selected: ["alpha"] });
    },
  );
  it("observes one settled generation under writer ownership without returning values or secrets", async () => {
    const f = fixture();
    await f.apply("a");
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: f.services,
      integrationSchemas: new Map(),
      infraDir: f.infraDir,
      env: {},
    });
    let release!: () => void, held!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reached = new Promise<void>((resolve) => {
      held = resolve;
    });
    const writer = coreServices.withConfigurationGenerationWriter(f.infraDir, async (owned) => {
      await owned.commit({
        services: f.services,
        input: {
          domain: "fixture.invalid",
          selectedRoots: ["alpha"],
          serviceConfigs: [],
          integrationConfigs: [{ integrationId: "demo", values: { label: "previous-applied" } }],
          serviceSecrets: [],
        },
      });
      held();
      await barrier;
    });
    await bounded(reached);
    const operation = { kind: "configuration.inspect" as const };
    let settled = false;
    const observation = dispatchOpsOperation(runtime, operation, {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog() {},
      claim: {
        operation,
        fingerprint: opsOperationFingerprint(operation),
        source: "registry",
        capability: { revisionId: "registry", values: {} },
      },
    }).then((result) => {
      settled = true;
      return result;
    });
    try {
      await delay(40);
      expect(settled).toBe(false);
    } finally {
      release();
      await writer;
    }
    const result = await bounded(observation);
    expect(result.revisionId).toBe(coreServices.currentConfigurationGeneration(f.infraDir));
    expect(result.integrationConfigDigests).toEqual([
      { integrationId: "demo", digest: expect.stringMatching(/^[a-f0-9]{64}$/) },
    ]);
    expect(JSON.stringify(result)).not.toContain("previous-applied");
    expect(result).not.toHaveProperty("serviceConfigs");
    expect(result).not.toHaveProperty("serviceSecrets");
  });
  it("distinguishes real pre-pointer and post-pointer failures and releases ownership", async () => {
    const f = fixture();
    await f.apply("a");
    expect(
      await f.apply("b", undefined, {
        beforeCommit: async () => {
          throw new Error("synthetic before");
        },
      }),
    ).toMatchObject({ outcome: "not_committed", reason: "failed" });
    expect(f.label()).toBe("a");
    expect(
      await f.apply("c", undefined, {
        afterCommit: async () => {
          throw new Error("synthetic after");
        },
      }),
    ).toMatchObject({ outcome: "committed", revisionId: revision("c"), followUp: "failed" });
    expect(f.label()).toBe("c");
    expect(await f.apply("d")).toMatchObject({ outcome: "committed", followUp: "complete" });
  });
  it("accepts absence and matching revisions, rejects stale compensation without changing B or follow-up files", async () => {
    const f = fixture();
    expect(await f.apply("a", null)).toMatchObject({ outcome: "committed" });
    expect(await f.apply("b", revision("a"))).toMatchObject({ outcome: "committed" });
    const routes = f.followUp();
    expect(await f.apply("c", revision("a"))).toMatchObject({
      outcome: "not_committed",
      reason: "conflict",
      currentRevisionId: revision("b"),
    });
    expect(await f.apply("d", null)).toMatchObject({
      outcome: "not_committed",
      reason: "conflict",
    });
    expect(f.label()).toBe("b");
    expect(f.followUp()).toBe(routes);
  });
  it("retains a committed revision when real writer cleanup fails and leaves the foreign lock intact", async () => {
    const f = fixture();
    const foreign = coreServices.configurationWriterLockPath(f.infraDir);
    const result = await f.apply("a", undefined, {
      afterCommit: async () => {
        // Another file took the lock's place; release must not remove it.
        rmSync(foreign);
        writeFileSync(foreign, "preserve", { mode: 0o600 });
      },
    });
    expect(result).toMatchObject({
      outcome: "committed",
      revisionId: revision("a"),
      followUp: "complete",
      cleanupFailed: true,
    });
    expect(f.label()).toBe("a");
    expect(readFileSync(foreign, "utf8")).toBe("preserve");
  });
  it("rejects unbound execution metadata even with a valid candidate revision", async () => {
    const f = fixture();
    const runtime = createUnavailableRuntime();
    installTrustedConfigurationRuntime(runtime, {
      services: f.services,
      integrationSchemas: new Map(),
      infraDir: f.infraDir,
      env: {},
    });
    const claimed = {
      ...(await configurationSource(runtime, f.infraDir)),
      kind: "stack.render" as const,
      revisionId: revision("a"),
      payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
      expectedCurrentRevisionId: null,
    };
    const operation = { ...claimed, expectedCurrentRevisionId: revision("b") };
    await expect(
      dispatchOpsOperation(runtime, operation, {
        execution: testExecution(),
        signal: new AbortController().signal,
        emitLog() {},
        claim: {
          operation: claimed,
          fingerprint: opsOperationFingerprint(claimed),
          source: "trusted-data",
          capability: {
            revisionId: claimed.revisionId,
            values: {},
            trustedConfiguration: {
              domain: "example.test",
              serviceConfigs: [],
              integrationConfigs: [],
              serviceSecrets: [],
            },
          },
        },
      }),
    ).rejects.toThrow("Trusted configuration apply failed");
    expect(coreServices.currentConfigurationGeneration(f.infraDir)).toBeNull();
  });
  it("binds strict expected-current metadata into operation identity", () => {
    const base = {
      expectedSourceRevision: "00000000-0000-4000-8000-000000000000",
      coordinatorMode: "require-running" as const,
      expectedCurrentRevisionId: null,
      kind: "stack.render" as const,
      revisionId: revision("a"),
      payloadDigest: "dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd",
    };
    const bound = { ...base, expectedCurrentRevisionId: revision("b") };
    expect(opsOperationSchema.safeParse(bound).success).toBe(true);
    expect(opsOperationFingerprint(bound)).not.toBe(opsOperationFingerprint(base));
    expect(
      opsOperationSchema.safeParse({ kind: base.kind, revisionId: base.revisionId }).success,
    ).toBe(false);
    for (const value of ["authority-v1", "", 1, {}, false])
      expect(
        opsOperationSchema.safeParse({ ...base, expectedCurrentRevisionId: value }).success,
      ).toBe(false);
  });
});

describe("authenticated conditional configuration admission", () => {
  it.each(["success", "cancellation"] as const)(
    "retains actual commit evidence after %s and deduplicates repeated operation identity",
    async (fault) => {
      const f = fixture();
      const token = Buffer.alloc(32, 7).toString("base64url");
      mkdirSync(join(f.infraDir, "data"), { mode: 0o700 });
      await provisionControlDirectories(f.infraDir);
      const installation = openControlInstallation({
        infraDir: f.infraDir,
        role: "ops-agent",
        serviceIds: ["alpha"],
      });
      // Portable API-producer fixture. This is not a PostgreSQL ownership proof;
      // the current PG suite covers the actual durable job/checkpoint boundary.
      const parentContext: JobContext = {
        jobId: randomUUID(),
        execution: { owner: randomUUID(), version: 1 },
        payload: {},
        signal: new AbortController().signal,
        log: async () => {},
        setProgress: async () => {},
        checkpoint: async (value) => {
          parentContext.checkpointResult = value;
        },
      };
      const prepared = prepareApiJobRoot(parentContext, "stack.render", "ownership.render"),
        { operationKey, requestedDeadlineAt } = prepared;
      const sourceRuntime = createUnavailableRuntime();
      installTrustedConfigurationRuntime(sourceRuntime, {
        infraDir: f.infraDir,
        services: f.services,
        integrationSchemas: new Map(),
        env: {},
      });
      const source = await configurationSource(sourceRuntime, f.infraDir);
      const payload = {
        domain: "a.example.test",
        serviceConfigs: [{ serviceId: "alpha", values: { label: "a" } }],
        integrationConfigs: [],
        serviceSecrets: [],
      };
      const sealed = prepareConfigurationCandidate({
        role: "api",
        nonce: "nonce_conditional1234567",
        operationKey,
        operationForRevision: (revisionId, payloadDigest) => ({
          ...source,
          kind: "stack.render",
          revisionId,
          payloadDigest,
          expectedCurrentRevisionId: null,
        }),
        payload,
      });
      const tokenPath = join(f.root, "api-token");
      writeFileSync(tokenPath, token, { mode: 0o600 });
      vi.stubEnv("OPS_AGENT_TOKEN_FILE", tokenPath);
      const attempt = prepareApiJobChildAttempt(
        parentContext,
        sealed.operation,
        operationKey,
        prepared,
      )!;
      await parentContext.checkpoint({ _parentExecution: prepared.parent, attempt });
      const parentAssertion = await issueApiJobChildAssertion(attempt);
      let journalRecords: readonly PersistedOpsJob[] = [];
      let executions = 0;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const claimer = createRegistryResourceClaimer({
        serviceIds: ["alpha"],
        integrationIds: [],
        trustedData: configurationPayloadSource,
      });
      const runtime = createUnavailableRuntime();
      installTrustedConfigurationRuntime(runtime, {
        infraDir: f.infraDir,
        services: f.services,
        integrationSchemas: new Map(),
        env: {},
        afterCommit: async () => {
          executions++;
          if (fault === "cancellation") await finished;
        },
      });
      const app = buildOpsAgentServer({
        tokens: {
          api: token,
          "data-manager": Buffer.alloc(32, 8).toString("base64url"),
        },
        resourceClaimer: claimer,
        controlInstallation: installation,
        journal: {
          records: () => journalRecords,
          replace: async (records) => {
            journalRecords = structuredClone(records);
          },
        },
        runtime,
      });
      let counter = 0;
      const submit = (
        operation: OpsOperation,
        key = operationKey,
        assertion = parentAssertion,
        body: unknown = payload,
      ) =>
        app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: { authorization: `Bearer ${token}`, "x-openmapx-parent-execution": assertion },
          payload: {
            version: 2,
            execution: { requestedDeadlineAt },
            requestId: `ops1_conditional${String(++counter).padStart(12, "0")}`,
            operationKey: key,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 20_000).toISOString(),
            operation,
            payload: body,
          },
        });
      try {
        const tampered = await submit({
          ...sealed.operation,
          expectedCurrentRevisionId: `cfg1_${"x".repeat(43)}`,
        } as OpsOperation);
        expect(tampered.statusCode).toBeGreaterThanOrEqual(400);
        const otherPayload = await submit(sealed.operation, operationKey, parentAssertion, {
          ...payload,
          domain: "b.example.test",
        });
        expect(otherPayload.statusCode).toBe(400);
        const first = await submit(sealed.operation);
        expect(first.statusCode).toBe(202);
        const id = first.json().result.operationId;
        // The journal names the payload by digest only; it never holds the values.
        expect(JSON.stringify(journalRecords)).not.toContain("a.example.test");
        expect(journalRecords[0]?.operation).toMatchObject({
          payloadDigest: configurationPayloadDigest(payload),
        });
        if (fault === "cancellation") {
          const enteredDeadline = performance.now() + 3_000;
          while (executions === 0 && performance.now() < enteredDeadline) await delay(10);
          expect(executions).toBe(1);
          const cancelled = app.inject({
            method: "DELETE",
            url: `/v1/operations/${id}`,
            headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" },
          });
          const cancelDeadline = performance.now() + 3_000;
          while (
            (
              await app.inject({
                method: "GET",
                url: `/v1/operations/${id}`,
                headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" },
              })
            ).json().result.state !== "termination_pending" &&
            performance.now() < cancelDeadline
          )
            await delay(10);
          finish();
          await cancelled;
        }
        const readStatus = async () =>
          (
            await app.inject({
              method: "GET",
              url: `/v1/operations/${id}`,
              headers: { authorization: `Bearer ${token}`, "x-ops-protocol-version": "2" },
            })
          ).json().result;
        const deadline = performance.now() + 3_000;
        let status = await readStatus();
        while (status.state !== "succeeded" && performance.now() < deadline) {
          await delay(10);
          status = await readStatus();
        }
        expect(status).toMatchObject({
          state: "succeeded",
          result: { outcome: "committed", revisionId: sealed.revisionId, cleanupFailed: false },
        });
        expect(f.label()).toBe("a");
        await f.apply("b");
        const replay = await submit(sealed.operation);
        expect(replay.json().result).toMatchObject({ operationId: id, state: "succeeded" });
        expect(executions).toBe(1);
        expect(f.label()).toBe("b");
        const changedBody = {
          ...sealed.operation,
          expectedCurrentRevisionId: `cfg1_${"b".repeat(43)}`,
        } as OpsOperation;
        const changedAttempt = prepareApiJobChildAttempt(
          parentContext,
          changedBody,
          operationKey,
          prepared,
        )!;
        await parentContext.checkpoint({
          _parentExecution: prepared.parent,
          attempt: changedAttempt,
        });
        const changed = await submit(
          changedBody,
          operationKey,
          await issueApiJobChildAssertion(changedAttempt),
        );
        expect(changed.statusCode).toBe(409);
      } finally {
        finish();
        await app.close();
        closeControlInstallation(installation);
      }
    },
  );
});
