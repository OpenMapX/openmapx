import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  type OpsOperation,
  opsOperationFingerprint,
  opsOperationSchema,
  sealTrustedConfigurationSnapshot,
} from "@openmapx/core/ops";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { testExecution } from "./__fixtures__/execution";
import type { PersistedOpsJob } from "./journal";
import { createRegistryResourceClaimer } from "./policy";
import { createUnavailableRuntime, dispatchOpsOperation } from "./runtime";
import { buildOpsAgentServer } from "./server";
import {
  installTrustedConfigurationRuntime,
  type TrustedConfigurationRuntimeOptions,
} from "./trusted-config-runtime";
import { createFileTrustedOpsDataSource } from "./trusted-config-source";

const roots: string[] = [];
afterEach(() => {
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
  mkdirSync(infraDir, { recursive: true });
  writeFileSync(join(infraDir, "service-selection.json"), '{"selected":["alpha"]}');
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
      expectedCurrentRevisionId: coreServices.currentConfigurationGeneration(infraDir),
      kind: "stack.render",
      revisionId: revision(letter),
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
    readFileSync(join(root, "services/traefik/config/dynamic/generated-routes.yml"), "utf8");
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
          kind,
          revisionId: revision("c"),
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
      expect(JSON.parse(readFileSync(join(f.infraDir, "service-selection.json"), "utf8"))).toEqual({
        selected: ["alpha"],
      });
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
  it("retains a committed revision when real writer cleanup fails and leaves the foreign contents intact", async () => {
    const f = fixture();
    const foreign = join(f.infraDir, ".trusted-config-writer", "foreign");
    const result = await f.apply("a", undefined, {
      afterCommit: async () => {
        writeFileSync(foreign, "preserve");
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
      kind: "stack.render" as const,
      revisionId: revision("a"),
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
      expectedCurrentRevisionId: null,
      kind: "stack.render" as const,
      revisionId: revision("a"),
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
  it.each(["success", "cleanup", "cancellation", "journal"] as const)(
    "retains actual commit evidence after %s failure and deduplicates repeated operation identity",
    async (fault) => {
      const f = fixture();
      const token = Buffer.alloc(32, 7).toString("base64url");
      const queue = join(f.root, "queue");
      mkdirSync(queue, { mode: 0o700 });
      mkdirSync(join(queue, ".claimed"), { mode: 0o700 });
      const sealed = sealTrustedConfigurationSnapshot({
        role: "api",
        token,
        nonce: "nonce_conditional1234567",
        operationKey: "opk1_conditionalApply123",
        operationForRevision: (revisionId) => ({
          kind: "stack.render",
          revisionId,
          expectedCurrentRevisionId: null,
        }),
        payload: {
          domain: "a.example.test",
          serviceConfigs: [{ serviceId: "alpha", values: { label: "a" } }],
          integrationConfigs: [],
          serviceSecrets: [],
        },
      });
      writeFileSync(join(queue, `${sealed.revisionId}.json`), sealed.bytes, { mode: 0o600 });
      const fileSource = createFileTrustedOpsDataSource({
        directory: queue,
        token,
        allowedUids: [statSync(queue).uid],
        expectedGid: statSync(queue).gid,
        afterTerminalLink: async () => {
          if (fault === "cleanup") throw new Error("synthetic terminal-link fault");
        },
      });
      const raceAdmission = fault === "success" || fault === "cleanup";
      const claimEntered = Promise.withResolvers<void>();
      const returnClaim = Promise.withResolvers<void>();
      const cleanupEntered = Promise.withResolvers<void>();
      const returnCleanup = Promise.withResolvers<void>();
      let holdFirstClaim = raceAdmission;
      let released = false;
      let terminalDurableAtRelease = false;
      let interimResultHidden = false;
      let journalRecords: readonly PersistedOpsJob[] = [];
      let executions = 0;
      let finish!: () => void;
      const finished = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const claimer = createRegistryResourceClaimer({
        serviceIds: ["alpha"],
        integrationIds: [],
        trustedData: {
          claim: async (...args) => {
            const resolved = await fileSource.claim(...args);
            if (!resolved || !("admission" in resolved)) return resolved;
            if (holdFirstClaim) {
              holdFirstClaim = false;
              claimEntered.resolve();
              await returnClaim.promise;
            }
            return {
              ...resolved,
              admission: {
                ...resolved.admission,
                release: async () => {
                  terminalDurableAtRelease = journalRecords.some(
                    (record) => record.state === "succeeded",
                  );
                  const interim = (
                    await app.inject({
                      method: "GET",
                      url: `/v1/operations/${journalRecords[0].operationId}`,
                      headers: { authorization: `Bearer ${token}` },
                    })
                  ).json().result;
                  interimResultHidden = interim.state === "running" && interim.result === undefined;
                  if (raceAdmission) {
                    cleanupEntered.resolve();
                    await returnCleanup.promise;
                  }
                  try {
                    await resolved.admission.release();
                  } finally {
                    released = true;
                  }
                },
              },
            };
          },
        },
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
        tokens: { api: token, "data-manager": Buffer.alloc(32, 8).toString("base64url") },
        resourceClaimer: claimer,
        journal: {
          records: () => journalRecords,
          replace: async (records) => {
            if (fault === "journal" && records.some((record) => record.state === "succeeded"))
              throw new Error("synthetic journal persistence fault");
            journalRecords = structuredClone(records);
          },
        },
        runtime,
      });
      let counter = 0;
      const submit = (operation: OpsOperation, key = "opk1_conditionalApply123") =>
        app.inject({
          method: "POST",
          url: "/v1/operations",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            version: 1,
            requestId: `ops1_conditional${String(++counter).padStart(12, "0")}`,
            operationKey: key,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 20_000).toISOString(),
            operation,
          },
        });
      try {
        const tampered = await submit({
          ...sealed.operation,
          expectedCurrentRevisionId: `cfg1_${"x".repeat(43)}`,
        } as OpsOperation);
        expect(tampered.statusCode).toBe(403);
        // The first request passes the early lookup and holds a real authenticated
        // claim. The second creates the job; resuming the first exercises raced
        // admission after the durable result exists but before cleanup settles.
        const raced = raceAdmission ? submit(sealed.operation).then((response) => response) : null;
        if (raceAdmission) await bounded(claimEntered.promise);
        const first = await submit(sealed.operation);
        expect(first.statusCode).toBe(202);
        const id = first.json().result.operationId;
        if (raceAdmission) {
          await bounded(cleanupEntered.promise);
          returnClaim.resolve();
          const racedAck = await raced;
          const duplicateAck = await submit(sealed.operation);
          for (const ack of [racedAck, duplicateAck]) {
            expect(ack?.statusCode).toBe(202);
            expect.soft(ack?.json().result).toMatchObject({ operationId: id, state: "running" });
          }
          const status = (
            await app.inject({
              method: "GET",
              url: `/v1/operations/${id}`,
              headers: { authorization: `Bearer ${token}` },
            })
          ).json().result;
          expect(status.state).toBe("running");
          expect(status.result).toBeUndefined();
          const events = (
            await app.inject({
              method: "GET",
              url: `/v1/operations/${id}/events?after=0&limit=100`,
              headers: { authorization: `Bearer ${token}` },
            })
          ).json().result.events;
          expect(
            events.filter((event: { type: string }) => event.type === "state").at(-1).state,
          ).toBe("running");
          expect(released).toBe(false);
          returnCleanup.resolve();
        }
        if (fault === "cancellation") {
          const enteredDeadline = performance.now() + 3_000;
          while (executions === 0 && performance.now() < enteredDeadline) await delay(10);
          expect(executions).toBe(1);
          const cancelled = app.inject({
            method: "DELETE",
            url: `/v1/operations/${id}`,
            headers: { authorization: `Bearer ${token}` },
          });
          const cancelDeadline = performance.now() + 3_000;
          while (
            (
              await app.inject({
                method: "GET",
                url: `/v1/operations/${id}`,
                headers: { authorization: `Bearer ${token}` },
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
              headers: { authorization: `Bearer ${token}` },
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
          result: {
            outcome: "committed",
            revisionId: sealed.revisionId,
            cleanupFailed: fault === "cleanup" || fault === "journal",
          },
        });
        expect(terminalDurableAtRelease).toBe(fault !== "journal");
        expect(released).toBe(fault !== "journal");
        expect(interimResultHidden).toBe(fault !== "journal");
        expect(f.label()).toBe("a");
        await f.apply("b");
        const replay = await submit(sealed.operation);
        expect(replay.json().result).toMatchObject({ operationId: id, state: "succeeded" });
        expect(executions).toBe(1);
        expect(f.label()).toBe("b");
        const changed = await submit({
          ...sealed.operation,
          expectedCurrentRevisionId: `cfg1_${"b".repeat(43)}`,
        } as OpsOperation);
        expect(changed.statusCode).toBe(409);
      } finally {
        returnClaim.resolve();
        returnCleanup.resolve();
        finish();
        await app.close();
      }
    },
  );
});
