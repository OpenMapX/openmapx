import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  assertDataManagerTerminal,
  closeControlInstallation,
  leaseStoreDirectory,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  openControlInstallation,
  openLeaseStore,
  pruneControlRecords,
  restoreAdmittedControlExecution,
} from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";
import { dataManagerTokenFile } from "../../test/data-manager-token";
import type { JobContext } from "../job-runner";
import { postgresCommitRelay } from "./fixtures/postgres-commit-relay";

/**
 * The application name of the spawned native API's database pool (`apps/api/src/db`).
 * This test process replaces that module with the fixture's pool and opens no
 * session with this name, so such sessions belong to the spawned API.
 */
const NATIVE_API_APPLICATION_NAME = "openmapx-api";

/** The lease in the agent's store that holds `target`, or null. */
function targetLease(infraDir: string, target: string): string | null {
  return (
    openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: "test" })
      .list()
      .find((lease) => lease.targets.includes(target))?.leaseId ?? null
  );
}
/** One lease as the agent's store records it now. */
function heldLease(infraDir: string, leaseId: string) {
  return openLeaseStore({ directory: leaseStoreDirectory(infraDir), purpose: "test" }).get(leaseId);
}

/**
 * A lease renewal a native API sent before it was killed can still commit after
 * the kill, for example when it was waiting on a row lock that the API's open
 * transaction held until PostgreSQL noticed the death. The lease is final only
 * once PostgreSQL has ended every session of the killed API.
 */
async function nativeApiSessionsEnded(sql: import("postgres").Sql): Promise<void> {
  const endBy = Date.now() + 30_000;
  while (
    (
      await sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${NATIVE_API_APPLICATION_NAME}`
    ).length
  ) {
    if (Date.now() > endBy) throw Error("Killed native API sessions did not end");
    await nativeDelay(20);
  }
}

/** Resolves once the native API's lease renewal is waiting on a row lock. */
async function nativeApiRenewalBlocked(sql: import("postgres").Sql): Promise<void> {
  const endBy = Date.now() + 30_000;
  while (
    !(
      await sql`SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${NATIVE_API_APPLICATION_NAME}
          AND wait_event_type = 'Lock'
          AND query LIKE ${'update "admin_job" set "result" = coalesce("admin_job"."result", %'}`
    ).length
  ) {
    if (Date.now() > endBy) {
      const sessions = await sql`SELECT state, wait_event_type, left(query, 80) AS query
        FROM pg_stat_activity
        WHERE datname = current_database() AND application_name = ${NATIVE_API_APPLICATION_NAME}`;
      throw Error(`No native API lease renewal waited on a row lock: ${JSON.stringify(sessions)}`);
    }
    await nativeDelay(20);
  }
}

/**
 * Whether the session whose UPDATE reply the relay holds is still inside its
 * transaction, so the update keeps its row lock while the reply is held. An
 * autocommit UPDATE, such as a lease renewal, has committed before its reply
 * arrives and holds no lock.
 */
async function heldUpdateInTransaction(
  sql: import("postgres").Sql,
  backendPid: number,
): Promise<boolean> {
  const endBy = Date.now() + 5_000;
  for (;;) {
    const [session] = await sql<{ state: string | null }[]>`SELECT state
      FROM pg_stat_activity WHERE pid = ${backendPid}`;
    // A backend reports its idle state when it finishes the request, which can
    // be after the relay has seen the command's completion message.
    if (session?.state !== "active" || Date.now() > endBy)
      return session?.state === "idle in transaction";
    await nativeDelay(5);
  }
}

type Fixture = Awaited<ReturnType<typeof createConfigurationPostgresFixture>>;
const state = vi.hoisted(() => ({
  fixture: null as unknown as Fixture,
  services: [] as services.LoadedService[],
}));
// Named external filesystem availability/publication I/O only. Authority,
// private readers, signatures, capacity CAS, SQL and routes stay installed.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, statfsSync: vi.fn(actual.statfsSync), renameSync: vi.fn(actual.renameSync) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, opendir: vi.fn(actual.opendir), unlink: vi.fn(actual.unlink) };
});
vi.mock("../../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("../../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("../service-registry", () => ({
  getServiceRegistry: () => ({
    list: () => state.services,
    get: (id: string) => state.services.find((service) => service.manifest.id === id),
    applyEnabledIds: (ids: Set<string>) => {
      for (const service of state.services) service.enabled = ids.has(service.manifest.id);
    },
  }),
}));
const writer = await import("../administrative-configuration-writer");
const prospective = await import("../prospective-configuration");
const { checkpointOwnedAdminJob } = await import("../admin-job-checkpoint");
const { encrypt } = await import("../secrets");

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "actual API candidate / production agent / PostgreSQL preparation",
  () => {
    const composeFixture = fileURLToPath(
      new URL(
        "../../../../ops-agent/src/__fixtures__/production-compose-config.ts",
        import.meta.url,
      ),
    );
    let fixture: Fixture;
    let host: Awaited<ReturnType<typeof ownedServiceHost>>;
    let app: ReturnType<typeof buildOpsAgentServer>;
    let installation: ReturnType<typeof openControlInstallation>;
    let dm: Awaited<ReturnType<typeof ownedDataManager>> | undefined;
    let actualPosts: Map<string, number>;
    beforeEach(async (context) => {
      // Synthetic example/* images have no published release.
      vi.stubEnv("OPENMAPX_RELEASE", "local");
      fixture = await createConfigurationPostgresFixture();
      state.fixture = fixture;
      const schemas = Object.fromEntries(
        ["motis", "ops-agent", "app-api", "traefik", "postgis", "redis", "data-manager"].map(
          (id) => [
            id,
            {
              type: "object",
              properties: {
                WORKERS: { type: "integer", default: 2 },
                TOKEN: { type: "string", "x-openmapx-secret": true },
              },
            },
          ],
        ),
      );
      if (context.task.name.includes("eighty future private secret mounts"))
        Object.assign(
          schemas["data-manager"]!.properties,
          Object.fromEntries(
            Array.from({ length: 80 }, (_, index) => [
              `P${String(index).padStart(3, "0")}_${"K".repeat(85)}`,
              { type: "string", "x-openmapx-secret": true },
            ]),
          ),
        );
      host = await ownedServiceHost({
        schemas,
        actualComposeConfig:
          context.task.name.includes("applied final") ||
          context.task.name.includes("contained final") ||
          context.task.name.includes("one ownership-only maintenance decision") ||
          context.task.name.includes("killed native API"),
        withHardlinks: context.task.name.includes("durable nonempty"),
        competeAfterDefaultCli: context.task.name.includes("competing generation=true"),
        ...(context.task.name.includes("actual default CLI")
          ? {
              defaultCliEntry: fileURLToPath(
                new URL("../../../../ops-agent/src/index.ts", import.meta.url),
              ),
            }
          : {}),
      });
      state.services = host.loaded;
      installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      const journal = await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json"));
      app = buildOpsAgentServer({
        tokens: {
          api: host.token,
          "data-manager": Buffer.alloc(32, 23).toString("base64url"),
        },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal,
        controlInstallation: installation,
      });
      actualPosts = new Map();
      app.addHook("onSend", async (request, _reply, payload) => {
        const kind = (request.body as { operation?: { kind?: string } } | undefined)?.operation
          ?.kind;
        if (request.method === "POST" && request.url === "/v1/operations" && kind)
          actualPosts.set(kind, (actualPosts.get(kind) ?? 0) + 1);
        return payload;
      });
      const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
      const tokenFile = join(host.root, "api-token");
      writeFileSync(tokenFile, host.token, { mode: 0o600 });
      for (const [key, value] of Object.entries({
        OPS_AGENT_URL: baseUrl,
        OPS_AGENT_TOKEN_FILE: tokenFile,
        OPENMAPX_SECRETS_KEY: "71".repeat(32),
      }))
        vi.stubEnv(key, value);
    });
    afterEach(async () => {
      await dm?.close();
      dm = undefined;
      await app?.close();
      if (installation) closeControlInstallation(installation);
      await fixture?.stop();
      if (host) rmSync(host.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
      state.services = [];
    });
    async function job(): Promise<JobContext> {
      const jobId = randomUUID(),
        execution = { owner: randomUUID(), version: 1 };
      await fixture.db.insert(schema.adminJob).values({
        id: jobId,
        type: "service.apply",
        payload: {},
        status: "running",
        protocol: { execution },
      });
      const ctx: JobContext = {
        jobId,
        jobType: "service.apply",
        execution,
        payload: {},
        signal: new AbortController().signal,
        checkpointResult: {},
        protocol: { execution },
        log: async () => {},
        setProgress: async () => {},
        checkpoint: async (result, progress, admissionKey, stepAddress, operations) => {
          const recorded = operations ?? (ctx.protocol?.operations as typeof operations);
          if (recorded) {
            const saved = await checkpointOwnedAdminJob(
              jobId,
              execution,
              result,
              recorded,
              progress,
              admissionKey,
              stepAddress,
              ctx.checkpointResult ?? {},
            );
            ctx.checkpointResult = saved.result;
            ctx.protocol = saved.protocol;
          } else {
            await fixture.db
              .update(schema.adminJob)
              .set({ result })
              .where(eq(schema.adminJob.id, jobId));
            ctx.checkpointResult = result;
          }
        },
      };
      return ctx;
    }
    async function renderJob(expectedCurrentRevisionId: string | null = host.initial.revisionId) {
      const ctx = await job();
      const payload = {
          expectedCurrentRevisionId,
          confirmed: true,
          coordinatorMode: "require-running",
        },
        actorId = "loopback-admin",
        key = "actual-render-nonempty-request-001";
      ctx.jobType = "compose.render";
      ctx.payload = {
        ...payload,
        _maintenanceRequest: { actorId, key, digest: "d".repeat(64) },
      };
      await fixture.db
        .update(schema.adminJob)
        .set({ type: ctx.jobType, payload: ctx.payload })
        .where(eq(schema.adminJob.id, ctx.jobId));
      return ctx;
    }
    function owned<T>(ctx: JobContext, run: () => Promise<T>) {
      return writer.withAdministrativeConfigurationJob(ctx, () =>
        writer.withAdministrativeConfigurationWriter(
          {
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            integrationIds: [],
          },
          run,
        ),
      );
    }
    it.each(["prepared", "save_attempted"])(
      "recovers only the proven-unissued ordinary checkpoint (phase=%s)",
      async (phase) => {
        const ctx = await job(),
          checkpoint = ctx.checkpoint;
        ctx.checkpoint = async (...args) => {
          await checkpoint(...args);
          if ((args[0]._configurationCandidate as { phase?: string } | undefined)?.phase === phase)
            throw Error("API stopped after durable checkpoint");
        };
        await expect(
          owned(ctx, async () => {
            const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              overlay: {
                purpose: "service-config",
                coordinatorMode: "ensure-running",
                changes: [
                  { kind: "service-config", serviceId: "motis", set: { WORKERS: 7 }, unset: [] },
                ],
              },
            });
            await prospective.persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode: "ensure-running",
            });
          }),
        ).rejects.toThrow("API stopped after durable checkpoint");
        expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
        const [original] = await fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, ctx.jobId));
        const candidate = (original!.result as Record<string, unknown>)
            ._configurationCandidate as Record<string, unknown>,
          path = join(host.candidates, `${candidate.sealedOperationKey}.json`),
          bytes = readFileSync(path),
          { claimAdminJob } = await import("../admin-job-state"),
          reclaimed = await claimAdminJob(original!);
        ctx.execution = (
          reclaimed!.protocol as { execution: NonNullable<JobContext["execution"]> }
        ).execution;
        ctx.checkpointResult = reclaimed!.result as Record<string, unknown>;
        ctx.protocol = reclaimed!.protocol;
        ctx.checkpoint = async (result, _progress, _key, _address, operations) => {
          const protocol = operations ? { ...ctx.protocol, operations } : ctx.protocol;
          await fixture.db
            .update(schema.adminJob)
            .set({ result, protocol: protocol as Record<string, unknown> })
            .where(eq(schema.adminJob.id, ctx.jobId));
          ctx.checkpointResult = result;
          ctx.protocol = protocol;
        };
        if (phase === "save_attempted") {
          await expect(
            owned(ctx, () => prospective.resumeRetainedConfigurationCandidate()),
          ).rejects.toThrow();
          expect(readFileSync(path).equals(bytes)).toBe(true);
          await expect(owned(await job(), async () => undefined)).rejects.toThrow(
            "Configuration writer unavailable",
          );
        } else {
          const complete = ctx.checkpoint;
          let interrupted = false;
          ctx.checkpoint = async (...args) => {
            if (
              !interrupted &&
              (args[0]._configurationCandidate as { phase?: string } | undefined)?.phase ===
                "discarded"
            ) {
              interrupted = true;
              throw Error("API stopped after original unlink");
            }
            return complete(...args);
          };
          await expect(
            owned(ctx, () => prospective.resumeRetainedConfigurationCandidate()),
          ).rejects.toThrow("API stopped after original unlink");
          expect(existsSync(path)).toBe(false);
          expect(
            await prospective.retainedConfigurationIntegrationIds(
              ctx,
              ctx.jobId,
              String(candidate.operationKey),
            ),
          ).toEqual([]);
          const result = await owned(ctx, () => prospective.resumeRetainedConfigurationCandidate());
          expect(result.configuration).toMatchObject({
            outcome: "not_committed",
            cleanupFailed: false,
          });
          expect(existsSync(path)).toBe(false);
          expect(ctx.checkpointResult?._configurationCandidate).toMatchObject({
            phase: "discarded",
          });
          await expect(owned(await job(), async () => "available")).resolves.toBe("available");
        }
        expect(actualPosts.get("serviceConfig.apply") ?? 0).toBe(0);
        expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
      },
      30000,
    );
    it.each(["saved", "applied", "missing", "corrupt", "credential-saved", "credential-recreated"])(
      "reclaims a killed native ordinary configuration without resealing or saving again (mode=%s)",
      async (mode) => {
        const key = `opk1_native_ordinary_${randomUUID().replaceAll("-", "")}`,
          database = new URL(process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL!);
        database.searchParams.set("search_path", fixture.schema);
        const credential = mode.startsWith("credential-"),
          afterRecreate = mode === "credential-recreated",
          applyKind = credential ? "vault.apply" : "serviceConfig.apply",
          readVersions = () =>
            credential
              ? fixture.sql`SELECT xmin::text AS version FROM service_secret WHERE service_id='motis'`
              : fixture.sql`SELECT xmin::text AS version FROM service_config WHERE service_id='motis'`;
        const relay = await postgresCommitRelay(database, async () => {
          const rows =
            await fixture.sql`SELECT result FROM admin_job WHERE payload->>'operationKey'=${key} LIMIT 2`;
          if (
            rows.length !== 1 ||
            rows[0]!.result?._configurationCandidate?.phase !==
              (afterRecreate ? "follow_up_pending" : "saved") ||
            rows[0]!.result?._configurationCandidate?.maintenanceId !== null
          )
            return false;
          return (
            (mode !== "applied" && !afterRecreate) ||
            Object.values(rows[0]!.protocol?.operations?.operations ?? {}).some((value) => {
              const operation = value as {
                kind?: string;
                terminal?: boolean;
                receiptDelivery?: object;
              };
              return (
                operation.kind === (afterRecreate ? "service.recreate" : applyKind) &&
                operation.terminal === true &&
                operation.receiptDelivery !== undefined
              );
            })
          );
        });
        const loader = createRequire(new URL("../../../package.json", import.meta.url)).resolve(
            "tsx/esm",
          ),
          script = fileURLToPath(
            new URL("./fixtures/native-configuration-api.ts", import.meta.url),
          ),
          children: ReturnType<typeof spawn>[] = [];
        const start = () => {
          const args = ["--import", loader, script],
            child = spawn(process.execPath, args, {
              cwd: host.root,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                DATABASE_URL: relay.databaseUrl,
                OPENMAPX_ROOT_DIR: host.root,
                NODE_ENV: "test",
                // One installation's API processes share its secret.
                BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
              },
            });
          children.push(child);
          child.stdout!.on("data", () => {});
          child.stderr!.on("data", () => {});
          const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
            (resolve, reject) => {
              child.once("error", reject);
              child.once("close", (code, signal) => {
                console.info(
                  JSON.stringify({
                    proof: "native-ordinary-api-exit",
                    argv: [process.execPath, ...args],
                    code,
                    signal,
                  }),
                );
                resolve({ code, signal });
              });
            },
          );
          child.stdin!.end(
            JSON.stringify({
              operationKey: key,
              action: credential ? "ordinary-service-secret" : "ordinary-service-config",
            }),
          );
          return { child, exited };
        };
        const first = start();
        try {
          await Promise.race([
            relay.reached,
            first.exited.then(() => {
              throw Error("Native ordinary API exited before saved checkpoint");
            }),
          ]);
          const [original] = await fixture.db.select().from(schema.adminJob),
            originalResult = original!.result as Record<string, unknown>,
            candidate = originalResult._configurationCandidate as Record<string, unknown>,
            path = join(host.candidates, `${candidate.sealedOperationKey}.json`),
            bytes = readFileSync(path),
            record = JSON.parse(bytes.toString()),
            parent = {
              operationKey: record.parentOperationKey,
              fingerprint: record.parentFingerprint,
              deadlineAt: record.parentDeadlineAt,
            },
            versions = await readVersions();
          const refused = ["missing", "corrupt"].includes(mode);
          expect(versions).toHaveLength(1);
          expect(candidate.phase).toBe(afterRecreate ? "follow_up_pending" : "saved");
          expect(actualPosts.get(applyKind) ?? 0).toBe(mode === "applied" || afterRecreate ? 1 : 0);
          first.child.kill("SIGKILL");
          expect((await first.exited).signal).toBe("SIGKILL");
          relay.release();
          await nativeApiSessionsEnded(fixture.sql);
          if (mode === "missing") rmSync(path);
          if (mode === "corrupt") {
            // A payload that no longer matches the candidate's snapshot is refused.
            const value = JSON.parse(bytes.toString());
            value.payload.domain = `corrupt.${value.payload.domain}`;
            writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
          }
          const [retained] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id)),
            lease = Date.parse(
              (retained!.protocol as Record<string, unknown>).observationLeaseUntil as string,
            );
          expect(Number.isFinite(lease)).toBe(true);
          while (Date.now() <= lease + 100)
            await nativeDelay(Math.min(1000, lease + 101 - Date.now()));
          if (!refused) expect(readFileSync(path).equals(bytes)).toBe(true);
          expect((await start().exited).code).toBe(refused ? 2 : 0);
          const [finished] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id)),
            result = finished!.result as Record<string, unknown>,
            protocol = finished!.protocol as Record<string, unknown>;
          expect(finished!.status).toBe(refused ? "running" : "success");
          expect((protocol.execution as { version: number }).version).toBe(2);
          if (refused) {
            expect(canonicalJson(result._configurationCandidate) === canonicalJson(candidate)).toBe(
              true,
            );
            expect(result.observation).toMatchObject({
              state: "unknown",
              reason: "recovery_required",
            });
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(actualPosts.get(applyKind) ?? 0).toBe(0);
            expect(await readVersions()).toEqual(versions);
            const next = await job();
            await expect(owned(next, async () => undefined)).rejects.toThrow(
              "Configuration writer unavailable",
            );
            return;
          }
          expect(result._parentExecution).toEqual(parent);
          expect(result._configurationCandidate).toMatchObject({
            candidateId: candidate.candidateId,
            revisionId: candidate.revisionId,
            phase: "settled",
          });
          expect(await readVersions()).toEqual(versions);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(candidate.revisionId);
          expect(actualPosts.get(applyKind)).toBe(1);
          expect(existsSync(path)).toBe(false);
          if (credential) {
            expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
            expect(actualPosts.get("service.recreate")).toBe(1);
          } else
            expect(
              host.calls.some(
                (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
              ),
            ).toBe(false);
          expect((await start().exited).code).toBe(0);
          const [duplicate] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, original!.id));
          expect(duplicate!.result).toEqual(result);
          expect(actualPosts.get(applyKind)).toBe(1);
          const next = await job();
          await owned(next, async () =>
            expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
          );
          console.info(
            JSON.stringify({
              proof: "native-ordinary-candidate-reclaimed",
              originalJobId: original!.id,
              ownerVersion: 2,
              originalCandidateId: candidate.candidateId,
              applyPosts: actualPosts.get(applyKind),
              desiredRowVersionUnchanged: true,
              nextWriterAvailable: true,
            }),
          );
        } finally {
          relay.release();
          for (const child of children)
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          await relay.close();
        }
      },
      180000,
    );
    it.each([
      "before-save",
      "during-save",
      "after-save",
      "after-settle",
      "before-root-start",
      "before-root-start-source",
      "before-root-start-daemon",
      "before-root-start-cancel-daemon",
      "before-save-cancel-daemon",
      "before-save-refused",
      "after-retirement-daemon",
      "before-retirement-daemon",
      "known-rollback-daemon",
      "unused-settled-daemon",
      "contained-retirement-daemon",
      "before-root-start-unattempted-cancel-daemon",
      "before-root-start-unattempted-daemon",
    ])(
      "reclaims the same killed native API through its durable nonempty original preparation (mode=%s)",
      async (mode) => {
        const preRootHelper = mode.startsWith("before-root-start"),
          beforeSave = mode.startsWith("before-save"),
          refusedPreparation = mode === "before-save-refused",
          contained = mode === "contained-retirement-daemon",
          retired = mode === "after-retirement-daemon" || contained,
          retirement = mode.includes("retirement"),
          unusedAfterSettle = mode === "unused-settled-daemon",
          knownRollback = mode === "known-rollback-daemon" || unusedAfterSettle,
          unattemptedHelper = mode.includes("before-root-start-unattempted"),
          unused = beforeSave || knownRollback;
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((value) => value.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const initialCoordinator = {
          ...host.row,
          Id: "c".repeat(64),
          State: preRootHelper ? "exited" : "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        if (contained) {
          const args = services.stackComposeArgs(host.stack),
            options = {
              signal: new AbortController().signal,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
            },
            config = JSON.parse(
              (await host.execFile("docker", [...args, "config", "--format", "json"], options))
                .stdout,
            ),
            hash = (
              await host.execFile("docker", [...args, "config", "--hash", "data-manager"], options)
            ).stdout
              .trim()
              .split(/\s+/)
              .at(-1)!,
            spec = config.services["data-manager"];
          Object.assign(initialCoordinator.Labels, { "com.docker.compose.config-hash": hash });
          host.setRuntimeInspections({
            [initialCoordinator.Id]: {
              Id: initialCoordinator.Id,
              Image: initialCoordinator.Image,
              State: { Status: "running", Running: true, Health: { Status: "healthy" } },
              Config: {
                Image: initialCoordinator.ConfigImage,
                Labels: initialCoordinator.Labels,
                Env: Object.entries(spec.environment ?? {}).map(
                  ([key, value]) => `${key}=${value}`,
                ),
              },
              Mounts: (spec.volumes ?? []).map(
                (value: { source: string; target: string; type: string; read_only?: boolean }) => ({
                  Type: value.type,
                  Source: value.source,
                  Destination: value.target,
                  RW: !value.read_only,
                }),
              ),
            },
          });
        }
        host.setRows([host.row, initialCoordinator]);
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "public-native-api-fixture");
        const prepareObserved = Promise.withResolvers<void>(),
          releaseReply = Promise.withResolvers<void>(),
          actualUrl = process.env.OPS_AGENT_URL!,
          key = `opk1_native_api_${randomUUID().replaceAll("-", "")}`;
        const busyId = refusedPreparation ? randomUUID() : undefined;
        let busyBefore: unknown;
        let holdPreparedReply =
            beforeSave || mode === "after-settle" || preRootHelper || unusedAfterSettle,
          preparePosts = 0,
          settlePosts = 0;
        const relay = createServer(async (request, response) => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            const body = Buffer.concat(chunks),
              headers = Object.fromEntries(
                Object.entries(request.headers).filter(
                  (entry): entry is [string, string] =>
                    typeof entry[1] === "string" &&
                    !["host", "content-length", "connection"].includes(entry[0]),
                ),
              ),
              forwarded = await fetch(actualUrl + request.url, {
                method: request.method,
                headers,
                ...(body.length ? { body } : {}),
              }),
              bytes = await forwarded.text();
            if (
              request.method === "POST" &&
              body.length &&
              JSON.parse(body.toString()).operation?.kind === "configurationMaintenance.prepare"
            ) {
              preparePosts++;
            }
            if (
              request.method === "POST" &&
              body.length &&
              JSON.parse(body.toString()).operation?.kind === "configurationMaintenance.settle"
            )
              settlePosts++;
            if (
              unattemptedHelper &&
              holdPreparedReply &&
              request.method === "POST" &&
              body.length &&
              JSON.parse(body.toString()).operation?.kind === "configuration.hardlinks.preview"
            ) {
              const [original] =
                await fixture.sql`SELECT result,protocol FROM admin_job WHERE payload->>'operationKey'=${key}`;
              if (
                original?.result?._configurationCandidate?.phase === "prepared" &&
                !Object.values(original.protocol?.operations?.operations ?? {}).some(
                  (value) => (value as { kind?: string }).kind === "service.start",
                )
              ) {
                prepareObserved.resolve();
                await releaseReply.promise;
              }
            }
            const parsed = JSON.parse(bytes);
            const wantedObservation = refusedPreparation
              ? parsed.result?.kind === "configurationMaintenance.prepare" &&
                parsed.result?.state === "failed"
              : preRootHelper
                ? parsed.result?.kind === "service.start" && parsed.result?.state === "succeeded"
                : parsed.result?.kind ===
                    (beforeSave
                      ? "configurationMaintenance.prepare"
                      : "configurationMaintenance.settle") &&
                  parsed.result?.state === "succeeded" &&
                  parsed.result?.result?.state === (beforeSave ? "prepared" : "settled");
            if (holdPreparedReply && request.method === "GET" && wantedObservation) {
              prepareObserved.resolve();
              await releaseReply.promise;
            }
            if (!response.destroyed) {
              response.writeHead(forwarded.status, { "content-type": "application/json" });
              response.end(bytes);
            }
          } catch {
            if (!response.destroyed) {
              response.writeHead(503);
              response.end("{}");
            }
          }
        });
        await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
        const address = relay.address();
        if (!address || typeof address === "string") throw Error("Native API relay unavailable");
        const database = new URL(process.env.OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL!);
        database.searchParams.set("search_path", fixture.schema);
        let originalBackendPid: number | undefined, racedBackendPid: number | undefined;
        let rollbackRaceRows: { id: string; version: string }[] | undefined;
        const sqlRelay =
          mode === "after-save" || mode === "during-save" || retirement || knownRollback
            ? await postgresCommitRelay(
                database,
                async (observation) => {
                  const rows =
                    await fixture.sql`SELECT result FROM admin_job WHERE payload->>'operationKey'=${key} LIMIT 2`;
                  if (rows.length !== 1) return false;
                  if (knownRollback) {
                    if (observation.command === "BEFORE_SERVICE_SECRET_INSERT") {
                      expect(rows[0]!.result?._configurationCandidate?.phase).toBe(
                        "save_attempted",
                      );
                      expect(rows[0]!.result?._configurationMaintenance?.phase).toBe("prepared");
                      racedBackendPid = observation.backendPid;
                      await fixture.db.insert(schema.serviceSecret).values({
                        id: randomUUID(),
                        serviceId: "data-manager",
                        key: "TOKEN",
                        ...encrypt("synthetic-independent-race"),
                      });
                      rollbackRaceRows = await fixture.sql<
                        { id: string; version: string }[]
                      >`SELECT id,xmin::text AS version FROM service_secret WHERE service_id='data-manager' AND key='TOKEN'`;
                      return false;
                    }
                    return (
                      !unusedAfterSettle &&
                      observation.backendPid === racedBackendPid &&
                      rows[0]!.result?._configurationCandidate?.phase === "rolled_back" &&
                      rows[0]!.result?._configurationMaintenanceRollback?.disposition ===
                        "known_rolled_back"
                    );
                  }
                  if (retirement) {
                    const c = rows[0]!.result?._configurationCandidate;
                    // The first UPDATE after the retirement checkpoint can be a lease
                    // renewal, which runs outside a transaction. Only the API's own
                    // transactional update keeps the job row locked while it is held.
                    return (
                      c?.phase === "settled" &&
                      (retired
                        ? !existsSync(join(host.candidates, `${c.sealedOperationKey}.json`))
                        : c.retirement?.version === 1 &&
                          existsSync(join(host.candidates, `${c.sealedOperationKey}.json`)) &&
                          (await heldUpdateInTransaction(fixture.sql, observation.backendPid)))
                    );
                  }
                  if (mode === "during-save") {
                    if (rows[0]!.result?._configurationCandidate?.phase !== "save_attempted")
                      return false;
                    const [actual] =
                      await fixture.sql`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=${observation.backendPid}
          AND state='idle in transaction' AND query LIKE 'insert into "service_secret"%') AS original_insert_pending`;
                    if (actual?.original_insert_pending !== true) return false;
                    originalBackendPid = observation.backendPid;
                    return true;
                  }
                  return (
                    rows[0]!.result?._configurationCandidate?.phase === "saved" &&
                    rows[0]!.result?._configurationMaintenanceDecision?.attempt === "not_attempted"
                  );
                },
                {
                  ...(knownRollback ? { observeFrontend: "service-secret-insert" as const } : {}),
                  ...(mode === "before-retirement-daemon" ? { lateHeldClose: true } : {}),
                  holdCommand: retirement
                    ? retired
                      ? "API_TERMINAL_UPDATE"
                      : "UPDATE"
                    : mode === "during-save"
                      ? "INSERT"
                      : "COMMIT",
                },
              )
            : undefined;
        let nativeRevision: string | undefined;
        host.setCreatingProcess(async (creatingArgs) => {
          if (preRootHelper && !creatingArgs.includes("--force-recreate")) {
            expect(creatingArgs.at(-1)).toBe("data-manager");
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            expect(dm!.preparePosts).toBe(0);
            initialCoordinator.State = "running";
            host.setRows([host.row, initialCoordinator]);
            return;
          }
          if (!nativeRevision) {
            const [saved] =
              await fixture.sql`SELECT result FROM admin_job WHERE payload->>'operationKey'=${key}`;
            nativeRevision = saved?.result?._configurationCandidate?.revisionId;
          }
          if (!nativeRevision) throw Error("Original native candidate revision unavailable");
          const args = services.stackComposeArgs(host.stack),
            options = {
              signal: new AbortController().signal,
              timeout: 15000,
              maxBuffer: 1024 * 1024,
            },
            config = JSON.parse(
              (await host.execFile("docker", [...args, "config", "--format", "json"], options))
                .stdout,
            ),
            hash = (
              await host.execFile("docker", [...args, "config", "--hash", "data-manager"], options)
            ).stdout
              .trim()
              .split(/\s+/)
              .at(-1)!,
            compose = services.configurationGenerationComposeFile(host.infraDir, nativeRevision),
            service = config.services["data-manager"],
            row = {
              ...host.row,
              Id: "d".repeat(64),
              ConfigImage: "example/data-manager:1",
              Labels: {
                ...host.row.Labels,
                "com.docker.compose.service": "data-manager",
                "com.docker.compose.project.working_dir": dirname(compose),
                "com.docker.compose.project.config_files": compose,
                "com.docker.compose.config-hash": hash,
              },
            };
          host.setRows([host.row, row]);
          host.setRuntimeInspections({
            [row.Id]: {
              Id: row.Id,
              Image: row.Image,
              State: { Status: "running", Running: true, Health: { Status: "healthy" } },
              Config: {
                Image: row.ConfigImage,
                Labels: row.Labels,
                Env: Object.entries(service.environment ?? {}).map(
                  ([key, value]) => `${key}=${value}`,
                ),
              },
              Mounts: [
                ...(service.volumes ?? []).map(
                  (value: {
                    source: string;
                    target: string;
                    type: string;
                    read_only?: boolean;
                  }) => ({
                    Type: value.type,
                    Source: value.source,
                    Destination: value.target,
                    RW: !value.read_only,
                  }),
                ),
                ...(service.secrets ?? []).map((value: { source: string; target: string }) => ({
                  Type: "bind",
                  Source: config.secrets[value.source].file,
                  Destination: `/run/secrets/${value.target}`,
                  RW: false,
                })),
              ],
            },
          });
        });
        const apiRequire = createRequire(new URL("../../../package.json", import.meta.url)),
          loader = apiRequire.resolve("tsx/esm"),
          script = fileURLToPath(
            new URL("./fixtures/native-configuration-api.ts", import.meta.url),
          ),
          children: ReturnType<typeof spawn>[] = [];
        const start = (action?: "reconcile") => {
          const args = ["--import", loader, script],
            child = spawn(process.execPath, args, {
              cwd: host.root,
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...process.env,
                DATABASE_URL: sqlRelay?.databaseUrl ?? database.toString(),
                OPENMAPX_ROOT_DIR: host.root,
                OPS_AGENT_URL: `http://127.0.0.1:${address.port}`,
                NODE_ENV: "test",
                // One installation's API processes share its secret.
                BETTER_AUTH_SECRET: process.env.BETTER_AUTH_SECRET,
              },
            });
          children.push(child);
          let output = "";
          child.stdout!.on("data", (chunk) => {
            if (output.length < 8192) output += chunk.toString();
          });
          child.stderr!.on("data", () => {});
          const exited = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
            output: string;
          }>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code, signal) => {
              console.info(
                JSON.stringify({
                  proof: "native-api-producer-exit",
                  argv: [process.execPath, ...args],
                  code,
                  signal,
                }),
              );
              resolve({ code, signal, output });
            });
          });
          child.stdin!.end(
            JSON.stringify({
              operationKey: key,
              ...(action
                ? { action }
                : preRootHelper
                  ? { action: "maintenance-ensure-running" }
                  : {}),
            }),
          );
          return { child, exited };
        };
        if (busyId) {
          await fixture.sql.begin(async (tx) => {
            const [lock] = await tx`SELECT pg_try_advisory_xact_lock(${0x4f4d58},${2}) AS acquired`;
            expect(lock!.acquired).toBe(true);
            await tx`INSERT INTO data_manager.jobs(id,kind,status,started_at) VALUES(${busyId}::uuid,'download-fonts','running',now())`;
          });
          busyBefore =
            await fixture.sql`SELECT *,xmin::text AS row_version FROM data_manager.jobs WHERE id=${busyId}::uuid`;
        }
        const nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs"))
          .renameSync;
        let containedRenameFaults = 0;
        const containedFault = contained
          ? vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
              if (
                basename(String(target)).startsWith("cfg1_") &&
                basename(String(source)).endsWith(".tmp")
              ) {
                containedRenameFaults++;
                throw Error("External native generation publication refused");
              }
              return nativeRename(source, target);
            })
          : undefined;
        const first = start();
        try {
          await Promise.race([
            unusedAfterSettle
              ? prepareObserved.promise
              : (sqlRelay?.reached ?? prepareObserved.promise),
            first.exited.then(async (exit) => {
              const [row] = await fixture.db.select().from(schema.adminJob),
                result = row?.result as Record<string, unknown> | undefined;
              const projection = (await import("../admin-job-projection")).readProjection(
                row?.protocol,
                result,
              );
              console.info(
                JSON.stringify({
                  proof: "native-before-interruption-diagnostic",
                  mode,
                  exitCode: exit.code,
                  fixtureOutput: exit.output.trim(),
                  status: row?.status,
                  candidatePhase: (result?._configurationCandidate as { phase?: string })?.phase,
                  maintenancePhase: (result?._configurationMaintenance as { phase?: string })
                    ?.phase,
                  operations: Object.values(projection.operations).map((value) => ({
                    kind: value.kind,
                    phase: value.phase,
                    errorClass: value.errorClass,
                  })),
                  prepares: preparePosts,
                  settlements: settlePosts,
                }),
              );
              throw Error("Native API exited before original checkpoint observation");
            }),
          ]);
          const [original] = await fixture.db.select().from(schema.adminJob);
          const originalResult = original!.result as Record<string, unknown>,
            parent = originalResult._parentExecution,
            candidate = originalResult._configurationCandidate as Record<string, unknown>,
            remote = (originalResult._configurationMaintenance ?? {
              maintenanceId: candidate.maintenanceId,
            }) as Record<string, unknown>;
          const originalOwner =
            mode === "after-settle" || retirement || unusedAfterSettle
              ? (
                  await import("../../../../ops-agent/src/configuration-maintenance-store")
                ).readOwnedConfigurationMaintenance(
                  restoreAdmittedControlExecution(
                    installation,
                    (remote.receipt as import("@openmapx/core/ops").ConfigurationMaintenanceReceipt)
                      .prepare,
                  ),
                )
              : null;
          const candidatePath = join(host.candidates, `${candidate.sealedOperationKey}.json`),
            candidateBytes = retired ? undefined : readFileSync(candidatePath),
            rootLease = () => targetLease(host.infraDir, "data-manager"),
            rootInode = rootLease();
          expect(rootInode === null).toBe(
            mode === "after-settle" ||
              preRootHelper ||
              refusedPreparation ||
              retirement ||
              unusedAfterSettle,
          );
          const refusedOwnerPath = join(
              host.infraDir,
              "state/ops-agent/control/configuration-maintenance",
              `${candidate.maintenanceId}.json`,
            ),
            refusedOwnerBytes = refusedPreparation ? readFileSync(refusedOwnerPath) : undefined;
          const helper = preRootHelper
              ? JSON.parse(candidateBytes!.toString()).coordinatorPrerequisite
              : null,
            helperAdmission =
              helper && !unattemptedHelper
                ? readFileSync(
                    join(
                      host.infraDir,
                      "state/ops-agent/control/executions",
                      `${helper.root.operationKey}.json`,
                    ),
                  )
                : null;
          if (helper) {
            expect(preparePosts).toBe(0);
            expect(dm!.preparePosts).toBe(0);
            expect(actualPosts.get("service.start") ?? 0).toBe(unattemptedHelper ? 0 : 1);
            if (unattemptedHelper)
              expect(
                existsSync(
                  join(
                    host.infraDir,
                    "state/ops-agent/control/executions",
                    `${helper.root.operationKey}.json`,
                  ),
                ),
              ).toBe(false);
          }
          nativeRevision = String(candidate.revisionId);
          expect(candidate.phase).toBe(
            beforeSave || preRootHelper
              ? "prepared"
              : mode === "during-save"
                ? "save_attempted"
                : retirement
                  ? "settled"
                  : knownRollback
                    ? "rolled_back"
                    : "saved",
          );
          expect(original!.status).toBe("running");
          const savedRows =
            await fixture.sql`SELECT xmin::text AS version FROM service_secret WHERE service_id='data-manager' AND key='TOKEN'`;
          expect(savedRows).toHaveLength(
            beforeSave || preRootHelper || mode === "during-save" ? 0 : 1,
          );
          // The held update keeps its transaction open on the job row. A renewal
          // sent during the hold waits on that row and commits only once
          // PostgreSQL has ended the killed API's transaction.
          if (mode === "before-retirement-daemon") await nativeApiRenewalBlocked(fixture.sql);
          first.child.kill("SIGKILL");
          expect((await first.exited).signal).toBe("SIGKILL");
          if (mode.endsWith("-cancel-daemon")) {
            await (await import("../job-runner")).jobRunner.cancel(original!.id);
            const [canceled] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id));
            expect(canceled!.status).toBe("cancel_pending");
            expect((canceled!.protocol as Record<string, unknown>).cancelRequestedAt).toBeTypeOf(
              "string",
            );
          }
          holdPreparedReply = false;
          releaseReply.resolve();
          sqlRelay?.release();
          await nativeApiSessionsEnded(fixture.sql);
          const [retained] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, original!.id));
          const lease = Date.parse(
            (retained!.protocol as Record<string, unknown>).observationLeaseUntil as string,
          );
          expect(Number.isFinite(lease)).toBe(true);
          while (Date.now() <= lease + 100)
            await nativeDelay(Math.min(1000, lease + 101 - Date.now()));
          expect(
            retired
              ? !existsSync(candidatePath)
              : readFileSync(candidatePath).equals(candidateBytes!),
          ).toBe(true);
          expect(rootLease()).toBe(rootInode);
          if (mode === "before-root-start-source")
            await fixture.db
              .insert(schema.serviceConfig)
              .values({ id: randomUUID(), serviceId: "motis", config: { WORKERS: 7 } });
          const resumed = await start(mode.endsWith("-daemon") ? "reconcile" : undefined).exited;
          expect(resumed.code).toBe(
            contained ||
              unused ||
              mode === "during-save" ||
              mode === "before-root-start-source" ||
              mode === "before-root-start-cancel-daemon" ||
              (unattemptedHelper && mode.endsWith("-cancel-daemon"))
              ? 2
              : 0,
          );
          const [finished] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id)),
            result = finished!.result as Record<string, unknown>,
            protocol = finished!.protocol as Record<string, unknown>;
          if (refusedPreparation) {
            expect(finished!.status).toBe("failed");
            expect(protocol.execution).toMatchObject({ version: 2 });
            expect(result._parentExecution).toEqual(parent);
            expect(result._configurationCandidate).toMatchObject({
              candidateId: candidate.candidateId,
              phase: "discarded",
            });
            expect(result.configuration).toMatchObject({
              outcome: "not_committed",
              reason: "busy",
            });
            expect(result._configurationMaintenance).toMatchObject({
              phase: "settled",
              receipt: { state: "settled", dmFence: null, decision: null },
            });
            expect(result._configurationMaintenanceDecision).toBeUndefined();
            expect(settlePosts).toBe(0);
            expect(dm!.settlePosts).toBe(0);
            expect(preparePosts).toBe(1);
            expect(dm!.preparePosts).toBe(1);
            expect(
              await fixture.sql`SELECT *,xmin::text AS row_version FROM data_manager.jobs WHERE id=${busyId!}::uuid`,
            ).toEqual(busyBefore);
            expect(readFileSync(refusedOwnerPath).equals(refusedOwnerBytes!)).toBe(true);
            const core = await import("@openmapx/core/build-artifacts"),
              records = await import(
                "../../../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records"
              ),
              owner = records.configurationMaintenanceOwnerRecordSchema.parse(
                JSON.parse(refusedOwnerBytes!.toString()),
              ),
              authority = restoreAdmittedControlExecution(installation, owner.plan.prepare);
            core.assertConfigurationMaintenanceRootClosure(authority);
            core.verifyLocalArtifactTargetRootRelease(authority);
            expect(existsSync(candidatePath)).toBe(false);
            expect(rootLease()).toBeNull();
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(
              host.calls.some(
                (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
              ),
            ).toBe(false);
            expect((await start().exited).code).toBe(2);
            const [duplicate] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id));
            expect(duplicate!.result).toEqual(finished!.result);
            const next = await job();
            await owned(next, async () =>
              expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
            );
            console.info(
              JSON.stringify({
                proof: "native-api-original-noguard-refusal-reclaimed",
                originalJobId: original!.id,
                prepares: 1,
                dmSettlements: 0,
                noGuardOwnerUnchanged: true,
                winningSqlRowUnchanged: true,
                desiredSecretRows: 0,
                originalCandidateDiscarded: true,
                nextWriterAvailable: true,
              }),
            );
            return;
          }
          if (mode === "before-save-cancel-daemon") {
            expect(resumed.output).toContain('"state":"observed","status":"canceled"');
            expect(finished!.status).toBe("canceled");
            expect(protocol.execution).toMatchObject({ version: 2 });
            expect(result._parentExecution).toEqual(parent);
            expect(protocol.cancelRequestedAt).toBeTypeOf("string");
            expect(result._configurationCandidate).toMatchObject({
              candidateId: candidate.candidateId,
              phase: "discarded",
            });
            expect(result.configuration).toMatchObject({ outcome: "not_committed" });
            expect(result._configurationMaintenance).toMatchObject({
              maintenanceId: remote.maintenanceId,
              receipt: {
                state: "settled",
                decision: { decision: "abandon" },
                dmFence: { state: "settled" },
                generation: "not_started",
                followUp: "not_started",
              },
            });
            expect(result._configurationMaintenanceDecision).toMatchObject({
              operation: { decision: "abandon" },
              attempt: "attempted",
            });
            expect(preparePosts).toBe(1);
            expect(settlePosts).toBe(1);
            expect(dm!.preparePosts).toBe(1);
            expect(dm!.settlePosts).toBe(1);
            expect(actualPosts.get("service.start") ?? 0).toBe(0);
            expect(
              host.calls.some(
                (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
              ),
            ).toBe(false);
            expect(existsSync(candidatePath)).toBe(false);
            expect(rootLease()).toBeNull();
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            const final = (
                result._configurationMaintenance as {
                  receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
                }
              ).receipt,
              core = await import("@openmapx/core/build-artifacts");
            expect(final.prepare.operationKey).toBe(candidate.prepareOperationKey);
            core.verifyLocalArtifactTargetRootRelease(
              restoreAdmittedControlExecution(installation, final.prepare),
            );
            expect((await start().exited).code).toBe(2);
            const [duplicate] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id));
            expect(duplicate!.result).toEqual(finished!.result);
            const next = await job();
            await owned(next, async () =>
              expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
            );
            console.info(
              JSON.stringify({
                proof: "native-prepared-api-canceled-unused",
                originalJobId: original!.id,
                originalRootOnly: true,
                prepares: 1,
                dmSettlements: 1,
                desiredSecretRows: 0,
                originalCandidateDiscarded: true,
                nextWriterAvailable: true,
              }),
            );
            return;
          }
          if (
            mode === "before-root-start-cancel-daemon" ||
            (unattemptedHelper && mode.endsWith("-cancel-daemon"))
          ) {
            expect(resumed.output).toContain('"state":"observed","status":"canceled"');
            expect(finished!.status).toBe("canceled");
            expect(protocol.execution).toMatchObject({ version: 2 });
            expect(result._parentExecution).toEqual(parent);
            expect(protocol.cancelRequestedAt).toBeTypeOf("string");
            expect(result._configurationCandidate).toMatchObject({
              candidateId: candidate.candidateId,
              phase: "discarded",
            });
            expect(result.configuration).toMatchObject({ outcome: "not_committed" });
            expect(result._configurationMaintenance).toBeUndefined();
            expect(result._configurationMaintenanceDecision).toBeUndefined();
            expect(preparePosts).toBe(0);
            expect(settlePosts).toBe(0);
            expect(dm!.preparePosts).toBe(0);
            expect(dm!.settlePosts).toBe(0);
            expect(actualPosts.get("service.start") ?? 0).toBe(unattemptedHelper ? 0 : 1);
            expect(host.calls.filter((args) => args.includes("up"))).toHaveLength(
              unattemptedHelper ? 0 : 1,
            );
            if (!unattemptedHelper)
              expect(
                readFileSync(
                  join(
                    host.infraDir,
                    "state/ops-agent/control/executions",
                    `${helper.root.operationKey}.json`,
                  ),
                ).equals(helperAdmission!),
              ).toBe(true);
            expect(existsSync(candidatePath)).toBe(false);
            expect(rootLease()).toBeNull();
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect((await start().exited).code).toBe(2);
            const [duplicate] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id));
            expect(duplicate!.result).toEqual(finished!.result);
            const next = await job();
            await owned(next, async () =>
              expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
            );
            console.info(
              JSON.stringify({
                proof: "native-pre-root-helper-canceled",
                originalJobId: original!.id,
                sameHelperAdmission: unattemptedHelper ? null : true,
                starts: unattemptedHelper ? 0 : 1,
                maintenancePosts: 0,
                desiredSecretRows: 0,
                originalCandidateDiscarded: true,
                nextWriterAvailable: true,
              }),
            );
            return;
          }
          if (mode === "before-root-start-source") {
            expect(finished!.status).toBe("failed");
            expect(protocol.execution).toMatchObject({ version: 2 });
            expect(result._parentExecution).toEqual(parent);
            expect(result._configurationCandidate).toMatchObject({
              candidateId: candidate.candidateId,
              phase: "discarded",
            });
            expect(result.configuration).toMatchObject({
              outcome: "not_committed",
              reason: "conflict",
            });
            expect(result._configurationMaintenance).toBeUndefined();
            expect(result._configurationMaintenanceDecision).toBeUndefined();
            expect(preparePosts).toBe(0);
            expect(settlePosts).toBe(0);
            expect(dm!.preparePosts).toBe(0);
            expect(dm!.settlePosts).toBe(0);
            expect(actualPosts.get("service.start")).toBe(1);
            expect(host.calls.filter((args) => args.includes("up"))).toHaveLength(1);
            expect(
              readFileSync(
                join(
                  host.infraDir,
                  "state/ops-agent/control/executions",
                  `${helper.root.operationKey}.json`,
                ),
              ).equals(helperAdmission!),
            ).toBe(true);
            expect(existsSync(candidatePath)).toBe(false);
            expect(rootLease()).toBeNull();
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect((await start().exited).code).toBe(2);
            const [duplicate] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id));
            expect(duplicate!.result).toEqual(finished!.result);
            const next = await job();
            await owned(next, async () =>
              expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
            );
            console.info(
              JSON.stringify({
                proof: "native-pre-root-helper-source-conflict",
                originalJobId: original!.id,
                sameHelperAdmission: true,
                starts: 1,
                maintenancePosts: 0,
                desiredSecretRows: 0,
                originalCandidateDiscarded: true,
                nextWriterAvailable: true,
              }),
            );
            return;
          }
          if (mode === "during-save") {
            expect(originalBackendPid).toBeTypeOf("number");
            expect(
              await fixture.sql`SELECT pid FROM pg_stat_activity WHERE pid=${originalBackendPid!}`,
            ).toHaveLength(0);
            expect(finished!.status).toBe("running");
            expect(protocol.execution).toMatchObject({ version: 2 });
            expect(canonicalJson(result._configurationCandidate) === canonicalJson(candidate)).toBe(
              true,
            );
            expect(result.observation).toMatchObject({
              state: "unknown",
              reason: "recovery_required",
            });
            expect(result._configurationMaintenanceDecision).toBeUndefined();
            expect(result._configurationMaintenanceRollback).toBeUndefined();
            expect(result._configurationMaintenance).toMatchObject({
              receipt: { state: "prepared", decision: null, generation: "not_started" },
            });
            expect(readFileSync(candidatePath).equals(candidateBytes!)).toBe(true);
            expect(rootLease()).toBe(rootInode);
            expect(preparePosts).toBe(1);
            expect(settlePosts).toBe(0);
            expect(dm!.settlePosts).toBe(0);
            expect(
              await fixture.sql`SELECT xmin::text AS version FROM service_secret WHERE service_id='data-manager' AND key='TOKEN'`,
            ).toEqual(savedRows);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(
              host.calls.some(
                (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
              ),
            ).toBe(false);
            const next = await job();
            await expect(owned(next, async () => undefined)).rejects.toThrow(
              "Configuration writer unavailable",
            );
            console.info(
              JSON.stringify({
                proof: "native-api-attempted-save-remains-unknown",
                originalJobId: original!.id,
                candidateId: candidate.candidateId,
                realOriginalTransactionTerminated: true,
                desiredRows: 0,
                abandonOrSettlePosts: 0,
                nextWriterRefused: true,
              }),
            );
            return;
          }
          expect(finished!.status).toBe(unused || contained ? "failed" : "success");
          expect((protocol.execution as { version: number }).version).toBe(2);
          expect(result._parentExecution).toEqual(parent);
          expect(result._configurationCandidate).toMatchObject({
            candidateId: candidate.candidateId,
            revisionId: candidate.revisionId,
            phase: unused ? "discarded" : "settled",
          });
          expect(result._configurationMaintenance).toMatchObject({
            maintenanceId: remote.maintenanceId,
            receipt: {
              state: "settled",
              decision: { decision: unused ? "abandon" : "continue" },
              dmFence: { state: "settled" },
            },
          });
          if (originalOwner) {
            const finalOwner = (
                await import("../../../../ops-agent/src/configuration-maintenance-store")
              ).readOwnedConfigurationMaintenance(
                restoreAdmittedControlExecution(installation, originalOwner.plan.prepare),
              ),
              canonical = (await import("@openmapx/core/ops")).canonicalJson;
            expect(canonical(finalOwner.final) === canonical(originalOwner.final)).toBe(true);
            expect(result._configurationMaintenanceSettle).toEqual(
              originalResult._configurationMaintenanceSettle,
            );
            expect(finalOwner.leaseId).toBe(originalOwner.leaseId);
          }
          if (knownRollback) {
            expect(result._configurationMaintenanceRollback).toEqual(
              originalResult._configurationMaintenanceRollback,
            );
            expect(
              await fixture.sql`SELECT id,xmin::text AS version FROM service_secret WHERE service_id='data-manager' AND key='TOKEN'`,
            ).toEqual(rollbackRaceRows);
            expect(result.configuration).toMatchObject({ outcome: "not_committed" });
          }
          expect(preparePosts).toBe(1);
          expect(await fixture.db.select().from(schema.adminJob)).toHaveLength(1);
          if (preRootHelper) {
            const retainedRecord = JSON.parse(candidateBytes!.toString())
                .privateMaintenancePreparation.serviceSecrets[0],
              [actualSaved] = await fixture.db.select().from(schema.serviceSecret);
            expect(
              actualSaved?.id === retainedRecord.id &&
                actualSaved?.ciphertext === retainedRecord.ciphertext &&
                actualSaved?.iv === retainedRecord.iv &&
                actualSaved?.tag === retainedRecord.tag,
            ).toBe(true);
          } else
            expect(
              await fixture.sql`SELECT xmin::text AS version FROM service_secret WHERE service_id='data-manager' AND key='TOKEN'`,
            ).toEqual(savedRows);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            unused || contained ? host.initial.revisionId : nativeRevision,
          );
          expect(existsSync(join(host.candidates, `${candidate.sealedOperationKey}.json`))).toBe(
            false,
          );
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
          expect(host.calls.filter((args) => args.includes("up"))).toHaveLength(
            unused || contained ? 0 : preRootHelper ? 2 : 1,
          );
          if (helper) {
            expect(actualPosts.get("service.start")).toBe(1);
            if (helperAdmission)
              expect(
                readFileSync(
                  join(
                    host.infraDir,
                    "state/ops-agent/control/executions",
                    `${helper.root.operationKey}.json`,
                  ),
                ).equals(helperAdmission!),
              ).toBe(true);
            else {
              const sourceControl = await import(
                "../../../../../packages/core/src/build-artifacts/control-authority"
              );
              expect(() =>
                sourceControl.verifyMaintenanceCoordinatorPrerequisite(
                  installation,
                  JSON.parse(candidateBytes!.toString()),
                ),
              ).not.toThrow();
            }
          }
          expect(host.calls.some((args) => args.includes("pull") || args.includes("restart"))).toBe(
            false,
          );
          if (contained) {
            expect(containedRenameFaults).toBe(1);
            expect(result.configuration).toMatchObject({
              outcome: "not_committed",
              reason: "failed",
            });
          }
          expect((await start().exited).code).toBe(unused || contained ? 2 : 0);
          const [duplicate] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, original!.id));
          expect(duplicate!.result).toEqual(finished!.result);
          expect(preparePosts).toBe(1);
          expect(settlePosts).toBe(1);
          expect(dm!.settlePosts).toBe(1);
          const next = await job();
          await owned(next, async () =>
            expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
          );
          console.info(
            JSON.stringify({
              proof: "native-api-original-candidate-reclaimed",
              mode,
              originalJobId: original!.id,
              ownerVersion: 2,
              originalCandidateId: candidate.candidateId,
              preparedPosts: preparePosts,
              realObserverLeaseElapsed: true,
              desiredRows: preRootHelper ? 1 : savedRows.length,
              ...(knownRollback
                ? {
                    actualAcknowledgedRollback: true,
                    independentRaceRowUnchanged: true,
                    candidateDesiredWrites: 0,
                  }
                : {}),
              sameCandidateUntilSettlement: true,
              nextWriterAvailable: true,
            }),
          );
        } finally {
          containedFault?.mockRestore();
          holdPreparedReply = false;
          releaseReply.resolve();
          sqlRelay?.release();
          for (const child of children)
            if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
          relay.closeAllConnections();
          await new Promise<void>((resolve) => relay.close(() => resolve()));
          await sqlRelay?.close();
          if (busyId)
            await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${busyId}::uuid AND kind='download-fonts'`;
        }
      },
      240000,
    );
    it("stages an inert exact candidate before a real desired-row transaction and actual agent generation commit", async () => {
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          overlay: {
            purpose: "service-config",
            coordinatorMode: "ensure-running",
            changes: [
              { kind: "service-config", serviceId: "motis", set: { WORKERS: 4 }, unset: [] },
            ],
          },
        });
        expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(readdirSync(host.candidates)).toHaveLength(1);
        expect(host.calls.some((args) => args.includes("up") || args.includes("pull"))).toBe(false);
        const receipt = await prospective.persistAndApplyProspectiveConfiguration(candidate, {
          coordinatorMode: "ensure-running",
        });
        expect(receipt).toMatchObject({
          saved: "committed",
          revisionId: candidate.revisionId,
          application: {
            outcome: "committed",
            revisionId: candidate.revisionId,
            followUp: "complete",
          },
        });
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(candidate.revisionId);
        expect((await fixture.db.select().from(schema.serviceConfig))[0]?.config).toEqual({
          WORKERS: 4,
        });
        const [saved] =
          await fixture.sql`SELECT id,xmin::text AS version FROM service_config WHERE service_id='motis'`;
        const savedCandidate = ctx.checkpointResult?._configurationCandidate as
          | { rowVersions?: unknown }
          | undefined;
        expect(savedCandidate?.rowVersions).toEqual([
          {
            kind: "service-config",
            ownerId: "motis",
            rowId: saved!.id,
            rowVersion: saved!.version,
            previousRowVersion: null,
            state: "present",
          },
        ]);
      });
    });
    it("keeps a captured strict registry generation when the live service registry changes during a read", async () => {
      const { resolveServiceConfigWithSourcesStrict } = await import("../service-config-resolver");
      await writer.withAdministrativeConfigurationRead({}, async (read) => {
        const service = state.services.find((service) => service.manifest.id === "motis")!;
        const properties = service.manifest.configSchema!.properties as Record<
          string,
          { default?: unknown }
        >;
        properties.WORKERS!.default = 91;
        const captured = read.services.find((service) => service.manifest.id === "motis")!.manifest;
        const resolved = await resolveServiceConfigWithSourcesStrict(
          { id: captured.id, configSchema: captured.configSchema },
          read,
        );
        expect(resolved.WORKERS?.value).toBe(2);
      });
    });
    it("refuses consumable publication before the exact desired-row transaction commits", async () => {
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          overlay: {
            purpose: "service-config",
            coordinatorMode: "ensure-running",
            changes: [
              { kind: "service-config", serviceId: "motis", set: { WORKERS: 4 }, unset: [] },
            ],
          },
        });
        // Diagnostic state is not commit authority, even for an internal caller.
        prospective.validatedConfigurationCandidateState(candidate).persisted = true;
        await expect(
          prospective.executeConfigurationMaintenanceStep(candidate, 0),
        ).rejects.toThrow();
        expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
      });
    });
    it("refuses an oversized retained full envelope before a desired-row write or consumable publication", async () => {
      for (const serviceId of ["motis", "ops-agent", "app-api", "traefik", "postgis"])
        await fixture.db
          .insert(schema.serviceSecret)
          .values({ id: randomUUID(), serviceId, key: "TOKEN", ...encrypt("ü".repeat(60000)) });
      const before = await fixture.db.select().from(schema.serviceConfig);
      const ctx = await job();
      await expect(
        owned(ctx, () =>
          prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            overlay: {
              purpose: "service-config",
              coordinatorMode: "ensure-running",
              changes: [
                { kind: "service-config", serviceId: "motis", set: { WORKERS: 4 }, unset: [] },
              ],
            },
          }),
        ),
      ).rejects.toThrow();
      expect(await fixture.db.select().from(schema.serviceConfig)).toEqual(before);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(host.calls.some((args) => args.includes("up") || args.includes("pull"))).toBe(false);
    });
    it("refuses host-source drift after preview before any desired-row persistence", async () => {
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          overlay: {
            purpose: "service-config",
            coordinatorMode: "ensure-running",
            changes: [
              { kind: "service-config", serviceId: "motis", set: { WORKERS: 8 }, unset: [] },
            ],
          },
        });
        writeFileSync(join(host.infraDir, ".env"), "MOTIS_SLOT_MEMORY=8g\n", { mode: 0o600 });
        const result = await prospective
          .persistAndApplyProspectiveConfiguration(candidate, { coordinatorMode: "ensure-running" })
          .catch((error) => error);
        expect(await fixture.db.select().from(schema.serviceConfig)).toHaveLength(0);
        expect(result).toBeInstanceOf(Error);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
      });
    });
    it("accepts a complete size-reducing correction of oversized unchanged legacy state", async () => {
      for (const serviceId of ["motis", "ops-agent", "app-api", "traefik", "postgis"])
        await fixture.db
          .insert(schema.serviceSecret)
          .values({ id: randomUUID(), serviceId, key: "TOKEN", ...encrypt("ü".repeat(60000)) });
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "ensure-running",
            changes: [
              { kind: "service-secret", serviceId: "postgis", key: "TOKEN", action: "delete" },
            ],
          },
        });
        expect(candidate.payloadBytes).toBeLessThanOrEqual(524288);
        const receipt = await prospective.persistAndApplyProspectiveConfiguration(candidate, {
          coordinatorMode: "ensure-running",
        });
        expect(receipt).toMatchObject({
          saved: "committed",
          application: { outcome: "committed" },
        });
        expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(4);
      });
    });
    it("runs the current immediate producer through a retained nonsecret API job and actual agent", async () => {
      const { applyTrustedConfiguration } = await import("../trusted-config-operations");
      const { createDurableOpsKey } = await import("../ops-client");
      const key = createDurableOpsKey("task012.immediate", randomUUID());
      const result = await applyTrustedConfiguration({
        kind: "serviceConfig.apply",
        serviceId: "motis",
        actorId: "loopback-admin",
        operationKey: key,
        overlay: {
          purpose: "service-config",
          coordinatorMode: "ensure-running",
          changes: [{ kind: "service-config", serviceId: "motis", set: { WORKERS: 7 }, unset: [] }],
        },
      });
      expect(result.revisionId).toBe(services.currentConfigurationGeneration(host.infraDir));
      const [retained] = await fixture.db.select().from(schema.adminJob);
      expect(retained).toMatchObject({
        type: "configuration.apply",
        status: "success",
        payload: { operationKey: key },
      });
      expect(JSON.stringify(retained?.payload)).not.toContain("WORKERS");
      expect(
        (retained?.result as { _configurationCandidate?: { phase?: string } })
          ?._configurationCandidate?.phase,
      ).toBe("settled");
      expect(readdirSync(host.candidates)).toEqual([]);
      expect(
        host.calls.some(
          (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
        ),
      ).toBe(false);
    });
    it("replays the retained immediate candidate result without publishing or reusing a changed intent", async () => {
      const { applyTrustedConfiguration } = await import("../trusted-config-operations");
      const { createDurableOpsKey } = await import("../ops-client");
      const options = {
        kind: "serviceConfig.apply" as const,
        serviceId: "motis",
        actorId: "loopback-admin",
        operationKey: createDurableOpsKey("task012.immediate-replay", randomUUID()),
        overlay: {
          purpose: "service-config" as const,
          coordinatorMode: "ensure-running" as const,
          changes: [
            { kind: "service-config" as const, serviceId: "motis", set: { WORKERS: 7 }, unset: [] },
          ],
        },
      };
      const result = await applyTrustedConfiguration(options),
        calls = host.calls.length;
      expect(await applyTrustedConfiguration(options)).toEqual(result);
      expect(host.calls).toHaveLength(calls);
      expect(await fixture.db.select().from(schema.adminJob)).toHaveLength(1);
      await expect(
        applyTrustedConfiguration({
          ...options,
          overlay: {
            ...options.overlay,
            changes: [{ ...options.overlay.changes[0]!, set: { WORKERS: 9 } }],
          },
        }),
      ).rejects.toThrow("conflicts");
      const { jobRunner } = await import("../job-runner");
      await expect(
        jobRunner.startImmediateCompose({
          actorId: options.actorId,
          operationKey: options.operationKey,
        }),
      ).rejects.toThrow("conflicts");
      expect((await fixture.db.select().from(schema.serviceConfig))[0]?.config).toEqual({
        WORKERS: 7,
      });
    });
    it("publishes one credential seed and recreates from it in the same retained job without another render", async () => {
      const { applyTrustedConfiguration } = await import("../trusted-config-operations"),
        { createDurableOpsKey } = await import("../ops-client");
      const before = readdirSync(join(host.infraDir, services.CONFIGURATION_GENERATIONS)).length;
      host.setCreatingProcess(async () => {
        const connection = await fixture.sql.reserve();
        let held = false;
        try {
          const [row] = await connection`SELECT pg_try_advisory_lock(${0x4f4d58},1) AS held`;
          held = row!.held === true;
          expect(held).toBe(false);
          const [checkpoint] =
            await connection`SELECT type, result->'_configurationCandidate'->>'phase' AS phase,
          result->'_completion' AS completion FROM admin_job`;
          expect(checkpoint!.phase).toBe("follow_up_pending");
          expect(checkpoint!.type).toBe("service.apply");
          expect(checkpoint!.completion).toMatchObject({
            result: { serviceCredential: { serviceId: "motis", followUp: "complete" } },
          });
        } finally {
          if (held) await connection`SELECT pg_advisory_unlock(${0x4f4d58},1)`;
          connection.release();
        }
      });
      const options = {
        kind: "vault.apply" as const,
        serviceId: "motis",
        actorId: "loopback-admin",
        followUp: "service-apply" as const,
        operationKey: createDurableOpsKey("task012.credential-apply", randomUUID()),
        overlay: {
          purpose: "service-secret" as const,
          coordinatorMode: "ensure-running" as const,
          changes: [
            {
              kind: "service-secret" as const,
              serviceId: "motis",
              key: "TOKEN",
              action: "set" as const,
              value: "synthetic-private-credential",
            },
          ],
        },
      };
      const applied = await applyTrustedConfiguration(options);
      expect(applied.revisionId).toBe(services.currentConfigurationGeneration(host.infraDir));
      expect(readdirSync(join(host.infraDir, services.CONFIGURATION_GENERATIONS))).toHaveLength(
        before + 1,
      );
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(readdirSync(host.candidates)).toEqual([]);
      const [job] = await fixture.db.select().from(schema.adminJob);
      expect((job?.result as Record<string, unknown>)?.serviceCredential).toMatchObject({
        serviceId: "motis",
        revisionId: applied.revisionId,
        followUp: "complete",
      });
      expect(await applyTrustedConfiguration(options)).toEqual(applied);
      expect(await fixture.db.select().from(schema.adminJob)).toHaveLength(1);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
    });
    it.each([false, true])(
      "retains current Compose preparation and exactly one stack effect with host failure=%s",
      async (fail) => {
        const { jobRunner } = await import("../job-runner");
        const { createDurableOpsKey } = await import("../ops-client");
        if (fail)
          host.setCreatingProcess(async () => {
            throw Error("Synthetic external Docker failure");
          });
        const options = {
          actorId: "loopback-admin",
          operationKey: createDurableOpsKey("task012.compose", randomUUID()),
        };
        const result = await jobRunner.startImmediateCompose(options);
        expect(result).toMatchObject({
          ok: !fail,
          stdout: "",
          hardlinks: { via: "none", entries: 0 },
        });
        expect(await jobRunner.startImmediateCompose(options)).toEqual(result);
        expect(host.calls.filter((args) => args.includes("up"))).toHaveLength(1);
        const [retained] = await fixture.db.select().from(schema.adminJob);
        expect(retained).toMatchObject({
          type: "compose.start",
          status: fail ? "failed" : "success",
        });
        expect(
          (
            (retained?.result as Record<string, unknown>)?._servicePreparations as Record<
              string,
              { revisionId: string }
            >
          )?.["compose-start"]?.revisionId,
        ).toBe(services.currentConfigurationGeneration(host.infraDir));
      },
    );
    it("settles an actual asynchronous empty hardlink owner without a coordinator or Docker lifecycle", async () => {
      const ctx = await job();
      const { executeAdminJobOperation } = await import("../admin-job-ops");
      const result = await executeAdminJobOperation(
        ctx,
        {
          kind: "configuration.hardlinks.apply",
          revisionId: host.initial.revisionId,
          coordinatorMode: "require-running",
        },
        "task012.empty-hardlinks",
        { durableIdentity: host.initial.revisionId },
      );
      expect(result).toEqual({
        applied: true,
        entries: 0,
        linked: 0,
        skipped: 0,
        pruned: 0,
        via: "none",
      });
      expect(host.calls.some((args) => args.includes("up") || args.includes("restart"))).toBe(
        false,
      );
    });
    it.each(["missing-generation", "disabled-coordinator"] as const)(
      "refuses a durable nonempty unavailable maintenance prerequisite before staging a writer fence (mode=%s)",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((value) => value.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        if (mode === "disabled-coordinator") await host.select(["motis"]);
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "synthetic-prerequisite-osm");
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "exited",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const pointer = join(host.infraDir, services.CURRENT_CONFIGURATION),
          hidden = join(host.root, "fixture-hidden-current");
        // External availability fault on this synthetic host's actual pointer;
        // immutable generation/config bytes are never rewritten.
        if (mode === "missing-generation") nodeFs.renameSync(pointer, hidden);
        try {
          const expectedCurrentRevisionId = services.currentConfigurationGeneration(host.infraDir);
          expect(expectedCurrentRevisionId === null).toBe(mode === "missing-generation");
          const key = `opk1_prerequisite_${randomUUID().replaceAll("-", "")}`;
          await expect(
            (await import("../trusted-config-operations")).applyTrustedConfiguration({
              kind: "vault.apply",
              serviceId: "data-manager",
              actorId: "loopback-admin",
              operationKey: key,
              expectedCurrentRevisionId,
              followUp: "service-apply",
              coordinatorMode: "ensure-running",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "ensure-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-prerequisite-secret",
                  },
                ],
              },
            }),
          ).rejects.toThrow();
          const [original] = await fixture.db.select().from(schema.adminJob);
          expect(original?.status).toBe("failed");
          expect(
            (original?.result as Record<string, unknown>)?._configurationCandidate === undefined,
          ).toBe(true);
          const candidates = host.candidates;
          expect(existsSync(candidates) ? readdirSync(candidates) : []).toEqual([]);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(actualPosts.get("service.start") ?? 0).toBe(0);
          expect(actualPosts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
          expect(dm.preparePosts).toBe(0);
          expect(dm.settlePosts).toBe(0);
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            expectedCurrentRevisionId,
          );
          const next = await job();
          await owned(next, async () =>
            expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
          );
        } finally {
          if (existsSync(hidden) && !existsSync(pointer)) nodeFs.renameSync(hidden, pointer);
        }
      },
      60000,
    );
    it("prepares an actual durable nonempty candidate with eighty future private secret mounts", async () => {
      for (let index = 0; index < 80; index++) {
        const key = `P${String(index).padStart(3, "0")}_${"K".repeat(85)}`;
        await fixture.db.insert(schema.serviceSecret).values({
          id: randomUUID(),
          serviceId: "data-manager",
          key,
          ...encrypt("synthetic-retained-secret"),
        });
      }
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((value) => value.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows(
        host.loaded.map((service, index) => ({
          ...host.row,
          Id: index.toString(16).padStart(64, "0"),
          State: "running",
          ConfigImage: services.serviceContainerImageReference(service.manifest.container),
          Labels: { ...host.row.Labels, "com.docker.compose.service": service.manifest.id },
        })),
      );
      const ctx = await job();
      await owned(ctx, async () => {
        const containers = await host.owned.inspectOwnedServices(new AbortController().signal);
        expect(containers.length).toBeGreaterThan(1);
        const preparation = prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          followUp: "service-apply",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "require-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "data-manager",
                key: "TOKEN",
                action: "set",
                value: "synthetic-prospective-capacity-credential",
              },
            ],
          },
        });
        const candidate = await preparation;
        expect(candidate).toMatchObject({
          affectedServiceIds: ["data-manager"],
          expectedCurrentRevisionId: host.initial.revisionId,
        });
        expect(candidate.revisionId).not.toBe(host.initial.revisionId);
        expect(dm!.preparePosts).toBe(0);
        expect(actualPosts.get("configurationMaintenance.prepare") ?? 0).toBe(0);
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
        expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(80);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
      });
    }, 60000);
    it("uses one ownership-only maintenance decision before a durable nonempty coordinator credential continuation", async () => {
      // Synthetic example/* images intentionally have no published release.
      vi.stubEnv("OPENMAPX_RELEASE", "local");
      vi.stubEnv("DOMAIN", "example.test");
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      const dmRow = {
        ...host.row,
        Id: "c".repeat(64),
        ConfigImage: "example/data-manager:1",
        Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
      };
      host.setRows([host.row, dmRow]);
      // Named external Docker I/O: the actual native Compose config/hash and
      // committed mount files drive the replacement container observation.
      host.setCreatingProcess(async (creatingArgs) => {
        if (!creatingArgs.includes("--force-recreate")) return;
        expect(creatingArgs.at(-1)).toBe("data-manager");
        expect(dm!.preparePosts).toBe(1);
        const revision = services.currentConfigurationGeneration(host.infraDir);
        if (!revision) throw Error("Actual committed generation unavailable");
        const args = services.stackComposeArgs(host.stack),
          options = {
            signal: new AbortController().signal,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          },
          config = JSON.parse(
            (await host.execFile("docker", [...args, "config", "--format", "json"], options))
              .stdout,
          ),
          hash = (
            await host.execFile("docker", [...args, "config", "--hash", "data-manager"], options)
          ).stdout
            .trim()
            .split(/\s+/)
            .at(-1)!,
          compose = services.configurationGenerationComposeFile(host.infraDir, revision),
          row = {
            ...dmRow,
            Id: "d".repeat(64),
            Labels: {
              ...dmRow.Labels,
              "com.docker.compose.project.working_dir": dirname(compose),
              "com.docker.compose.project.config_files": compose,
              "com.docker.compose.config-hash": hash,
            },
          },
          service = config.services["data-manager"];
        host.setRows([host.row, row]);
        host.setRuntimeInspections({
          [row.Id]: {
            Id: row.Id,
            Image: row.Image,
            State: { Status: "running", Running: true, Health: { Status: "healthy" } },
            Config: {
              Image: row.ConfigImage,
              Labels: row.Labels,
              Env: Object.entries(service.environment ?? {}).map(
                ([key, value]) => `${key}=${value}`,
              ),
            },
            Mounts: [
              ...(service.volumes ?? []).map(
                (value: { source: string; target: string; type: string; read_only?: boolean }) => ({
                  Type: value.type,
                  Source: value.source,
                  Destination: value.target,
                  RW: !value.read_only,
                }),
              ),
              ...(service.secrets ?? []).map((value: { source: string; target: string }) => ({
                Type: "bind",
                Source: config.secrets[value.source].file,
                Destination: `/run/secrets/${value.target}`,
                RW: false,
              })),
            ],
          },
        });
      });
      const source = join(host.infraDir, "data/source-osm");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
      const { applyTrustedConfiguration } = await import("../trusted-config-operations"),
        { createDurableOpsKey } = await import("../ops-client");
      const options = {
        kind: "vault.apply" as const,
        serviceId: "data-manager",
        actorId: "loopback-admin",
        followUp: "service-apply" as const,
        operationKey: createDurableOpsKey("task012.maintenance-credential", randomUUID()),
        overlay: {
          purpose: "service-secret" as const,
          coordinatorMode: "ensure-running" as const,
          changes: [
            {
              kind: "service-secret" as const,
              serviceId: "data-manager",
              key: "TOKEN",
              action: "set" as const,
              value: "synthetic-private-coordinator-token",
            },
          ],
        },
      };
      const applied = await applyTrustedConfiguration(options);
      expect(applied.revisionId).toBe(services.currentConfigurationGeneration(host.infraDir));
      expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
      const [retained] = await fixture.db.select().from(schema.adminJob);
      expect(retained?.status).toBe("success");
      const checkpoint = (retained?.result as Record<string, unknown>)
        ._configurationMaintenance as {
        phase: string;
        decision: { decision: string };
      };
      expect(checkpoint.phase).toBe("settled");
      expect(checkpoint.decision.decision).toBe("continue");
      expect(await applyTrustedConfiguration(options)).toEqual(applied);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(actualPosts.get("configurationMaintenance.prepare")).toBe(1);
      expect(actualPosts.get("configurationMaintenance.decide")).toBe(1);
      expect(actualPosts.get("configurationMaintenance.settle")).toBe(1);
    }, 60000);
    it("preflights an inert durable nonempty coordinator candidate with original maintenance and apply identities", async () => {
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          followUp: "service-apply",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "ensure-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "data-manager",
                key: "TOKEN",
                action: "set",
                value: "synthetic-coordinator-credential",
              },
            ],
          },
        });
        const { record, sealed } = prospective.validatedConfigurationCandidateState(candidate);
        const { controlChildOperationKey } = await import("@openmapx/core/build-artifacts");
        expect(record.maintenanceId).toEqual(expect.any(String));
        expect(record.prepareOperationKey).toEqual(expect.stringMatching(/^opk1_t1_/));
        expect(record.operationKey).toBe(
          controlChildOperationKey(record.prepareOperationKey!, "configuration-commit", 0),
        );
        expect(sealed.operation).toMatchObject({
          maintenanceId: record.maintenanceId,
          candidateId: candidate.candidateId,
          kind: "vault.apply",
          serviceId: "data-manager",
        });
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(host.calls.some((args) => args.includes("up") || args.includes("pull"))).toBe(false);
      });
    });
    it("settles the old-revision prerequisite before durable nonempty maintenance admission with an initially stopped coordinator", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      const coordinator = {
        ...host.row,
        Id: "c".repeat(64),
        State: "exited",
        ConfigImage: "example/data-manager:1",
        Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
      };
      host.setRows([host.row, coordinator]);
      let started = 0;
      host.setCreatingProcess(async (args) => {
        expect(args.at(-1)).toBe("data-manager");
        expect(args).not.toContain("--force-recreate");
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(
          await fixture.sql`SELECT maintenance_id FROM data_manager.configuration_fence`,
        ).toEqual([]);
        expect(readdirSync(host.candidates)).toHaveLength(1);
        coordinator.State = "running";
        host.setRows([host.row, coordinator]);
        started++;
      });
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          followUp: "service-apply",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "ensure-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "data-manager",
                key: "TOKEN",
                action: "set",
                value: "synthetic-coordinator-credential",
              },
            ],
          },
        });
        expect(started).toBe(0);
        const { verifyMaintenanceCoordinatorPrerequisite } = await import(
          "@openmapx/core/build-artifacts"
        );
        const { record } = prospective.validatedConfigurationCandidateState(candidate);
        expect(() => verifyMaintenanceCoordinatorPrerequisite(installation, record)).toThrow();
        // Stage only the real ordinary prerequisite, before the independently
        // coordinated maintenance admission and desired transaction.
        await prospective.stageProspectiveConfigurationMaintenance(candidate);
        expect(started).toBe(1);
        const projection = ctx.protocol!.operations as {
          operations: Record<
            string,
            { operation: unknown; phase: string; receiptDelivery?: { phase?: string } }
          >;
        };
        const starts = Object.values(projection.operations).filter(
          (operation) => (operation.operation as { kind: string }).kind === "service.start",
        );
        expect(starts).toHaveLength(1);
        expect(starts[0]!.operation).toEqual({
          kind: "service.start",
          serviceId: "data-manager",
          expectedConfigurationRevisionId: host.initial.revisionId,
        });
        expect(starts[0]!.phase).toBe("terminal");
        expect(starts[0]!.receiptDelivery).toBeDefined();
        expect(() => verifyMaintenanceCoordinatorPrerequisite(installation, record)).not.toThrow();
        expect(() =>
          verifyMaintenanceCoordinatorPrerequisite(installation, {
            ...record,
            coordinatorPrerequisite: {
              ...record.coordinatorPrerequisite!,
              operation: {
                ...record.coordinatorPrerequisite!.operation,
                expectedConfigurationRevisionId: candidate.revisionId,
              },
            },
          }),
        ).toThrow();
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(
          await fixture.sql`SELECT maintenance_id FROM data_manager.configuration_fence`,
        ).toEqual([]);
      });
    }, 60000);
    it("discards an actual durable nonempty unissued candidate after its settled helper and original parent deadline expire", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      const coordinator = {
        ...host.row,
        Id: "c".repeat(64),
        State: "exited",
        ConfigImage: "example/data-manager:1",
        Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
      };
      host.setRows([host.row, coordinator]);
      let starts = 0;
      host.setCreatingProcess(async (args) => {
        expect(args.at(-1)).toBe("data-manager");
        expect(args).not.toContain("--force-recreate");
        coordinator.State = "running";
        host.setRows([host.row, coordinator]);
        starts++;
      });
      const ctx = await job(),
        { prepareApiJobRoot } = await import("../admin-job-parent"),
        initial = prepareApiJobRoot(
          ctx,
          "configurationMaintenance.prepare",
          "synthetic-pre-root-short-initial-budget",
        );
      await ctx.checkpoint({
        ...ctx.checkpointResult,
        _parentExecution: { ...initial.parent, deadlineAt: Date.now() + 60000 },
      });
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "ensure-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-helper-parent-expiry",
                },
              ],
            },
          }),
          state = prospective.validatedConfigurationCandidateState(candidate),
          parent = structuredClone(ctx.checkpointResult!._parentExecution);
        await prospective.stageProspectiveConfigurationMaintenance(candidate);
        expect(starts).toBe(1);
        expect(dm!.preparePosts).toBe(0);
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
        const helperPath = join(
            host.infraDir,
            "state/ops-agent/control/executions",
            `${state.record.coordinatorPrerequisite!.root.operationKey}.json`,
          ),
          admission = readFileSync(helperPath);
        while (Date.now() <= state.record.parentDeadlineAt)
          await nativeDelay(Math.min(1000, state.record.parentDeadlineAt - Date.now() + 10));
        expect(state.sealed.snapshot.expiresAt > new Date().toISOString()).toBe(true);
        await expect(
          prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "ensure-running",
          }),
        ).rejects.toMatchObject({
          result: {
            configuration: { outcome: "not_committed", reason: "conflict", cleanupFailed: false },
          },
        });
        expect(ctx.checkpointResult!._parentExecution).toEqual(parent);
        expect(ctx.checkpointResult!._configurationCandidate).toMatchObject({
          candidateId: candidate.candidateId,
          phase: "discarded",
        });
        expect(readFileSync(helperPath).equals(admission)).toBe(true);
        expect(starts).toBe(1);
        expect(dm!.preparePosts).toBe(0);
        expect(dm!.settlePosts).toBe(0);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(readdirSync(host.candidates)).toHaveLength(0);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
      });
      const next = await job();
      await owned(next, async () =>
        expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
      );
    }, 120000);
    it("retains an actual durable nonempty unissued candidate after a helper observer failure even when its next lookup succeeds", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      const coordinator = {
        ...host.row,
        Id: "c".repeat(64),
        State: "exited",
        ConfigImage: "example/data-manager:1",
        Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
      };
      host.setRows([host.row, coordinator]);
      let starts = 0;
      host.setCreatingProcess(async (args) => {
        expect(args.at(-1)).toBe("data-manager");
        expect(args).not.toContain("--force-recreate");
        coordinator.State = "running";
        host.setRows([host.row, coordinator]);
        starts++;
      });
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "ensure-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-helper-observer-loss",
                },
              ],
            },
          }),
          state = prospective.validatedConfigurationCandidateState(candidate),
          path = join(host.candidates, `${state.record.operationKey}.json`),
          bytes = readFileSync(path),
          actualFetch = globalThis.fetch;
        let losses = 0,
          failure: unknown;
        const transport = vi
          .spyOn(globalThis, "fetch")
          .mockImplementation(async (input, options) => {
            const response = await actualFetch(input, options);
            if (
              (options?.method ?? "GET") === "GET" &&
              new URL(String(input)).pathname.startsWith("/v1/operations/") &&
              !String(input).includes("/events") &&
              losses < 3
            ) {
              const body = await response.clone().json();
              if (body.result?.kind === "service.start" && body.result?.state === "succeeded") {
                losses++;
                throw Error("Synthetic original helper terminal HTTP observation loss");
              }
            }
            return response;
          });
        try {
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "ensure-running",
          });
        } catch (error) {
          failure = error;
        } finally {
          transport.mockRestore();
        }
        expect(losses).toBe(3);
        expect(failure).toBeInstanceOf((await import("../ops-client")).OpsObservationPending);
        expect(ctx.checkpointResult!._configurationCandidate).toMatchObject({
          candidateId: candidate.candidateId,
          phase: "prepared",
        });
        expect(readFileSync(path).equals(bytes)).toBe(true);
        expect(dm!.preparePosts).toBe(0);
        expect(starts).toBe(1);
        await prospective.stageProspectiveConfigurationMaintenance(candidate);
        expect(starts).toBe(1);
        expect(dm!.preparePosts).toBe(0);
        expect(readFileSync(path).equals(bytes)).toBe(true);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
      });
    }, 60000);
    it("refuses and discards an actual durable nonempty pre-root candidate after a settled helper source race", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      const coordinator = {
        ...host.row,
        Id: "c".repeat(64),
        State: "exited",
        ConfigImage: "example/data-manager:1",
        Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
      };
      host.setRows([host.row, coordinator]);
      let starts = 0;
      host.setCreatingProcess(async (args) => {
        expect(args).not.toContain("--force-recreate");
        expect(args.at(-1)).toBe("data-manager");
        coordinator.State = "running";
        host.setRows([host.row, coordinator]);
        starts++;
      });
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          followUp: "service-apply",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "ensure-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "data-manager",
                key: "TOKEN",
                action: "set",
                value: "synthetic-pre-root-race",
              },
            ],
          },
        });
        await prospective.stageProspectiveConfigurationMaintenance(candidate);
        // Race only after the genuine old-revision Start has settled, before
        // maintenance admission; changing source during Docker up is earlier.
        await fixture.db
          .insert(schema.serviceConfig)
          .values({ id: randomUUID(), serviceId: "motis", config: { WORKERS: 7 } });
        await expect(
          prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "ensure-running",
          }),
        ).rejects.toMatchObject({
          result: {
            configuration: { outcome: "not_committed", reason: "conflict", cleanupFailed: false },
          },
        });
        expect(starts).toBe(1);
        expect(dm!.preparePosts).toBe(0);
        expect(dm!.settlePosts).toBe(0);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
        expect(coordinator.State).toBe("running");
        expect(ctx.checkpointResult!._configurationCandidate).toMatchObject({
          candidateId: candidate.candidateId,
          phase: "discarded",
        });
        expect(readdirSync(host.candidates)).toHaveLength(0);
      });
      const next = await job();
      await owned(next, async () =>
        expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
      );
    }, 60000);
    it.each(["source", "guard", "lost-response"] as const)(
      "refreshes actual durable nonempty maintenance inspection from the original API job with drift=%s",
      async (drift) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "ensure-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-coordinator-credential",
                },
              ],
            },
          });
          await prospective.stageProspectiveConfigurationMaintenance(candidate);
          const maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            identity = {
              maintenanceId: prepared.binding.maintenanceId,
              candidateId: candidate.candidateId,
            },
            beforeLifecycle = host.calls.filter(
              (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
            ).length;
          expect(await maintenance.inspectConfigurationMaintenance(identity)).toMatchObject({
            state: "prepared",
            preflight: "current",
            sequence: prepared.sequence,
          });
          await expect(async () =>
            prospective.discardNeverPreparedProspectiveConfiguration(candidate),
          ).rejects.toThrow("Conclusive never-prepared maintenance closure required");
          expect(readdirSync(host.candidates)).toHaveLength(1);
          const { createApiOpsClient, createDurableOpsKey } = await import("../ops-client"),
            { prepareApiJobChildAttempt, issueApiJobChildAssertion } = await import(
              "../admin-job-parent"
            ),
            inspect = { kind: "configurationMaintenance.inspect" as const, ...identity },
            client = createApiOpsClient();
          await expect(client.execute(inspect)).rejects.toMatchObject({
            errorClass: "authorization",
          });
          const other = await job(),
            key = createDurableOpsKey("task012.wrong-maintenance-inspector", other.jobId),
            attempt = prepareApiJobChildAttempt(other, inspect, key)!;
          await other.checkpoint({ ...other.checkpointResult, _inspectionAttempt: attempt });
          await expect(
            client.execute(inspect, {
              operationKey: key,
              execution: { requestedDeadlineAt: attempt.requestedDeadlineAt },
              parentAssertion: await issueApiJobChildAssertion(attempt),
            }),
          ).rejects.toMatchObject({ errorClass: "authorization" });
          if (drift === "source") {
            const envPath = join(host.infraDir, ".env"),
              descriptor = nodeFs.openSync(
                envPath,
                nodeFs.constants.O_RDWR | nodeFs.constants.O_NOFOLLOW | nodeFs.constants.O_NONBLOCK,
              ),
              originalSize = nodeFs.fstatSync(descriptor).size;
            try {
              nodeFs.writeSync(
                descriptor,
                "\nTASK012_INSPECTION_SOURCE_DRIFT=changed\n",
                originalSize,
                "utf8",
              );
              expect(await maintenance.inspectConfigurationMaintenance(identity)).toMatchObject({
                state: "prepared",
                preflight: "drifted",
                sequence: prepared.sequence,
              });
            } finally {
              try {
                nodeFs.ftruncateSync(descriptor, originalSize);
              } finally {
                nodeFs.closeSync(descriptor);
              }
            }
          } else if (drift === "guard") {
            await fixture.sql`DELETE FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`;
            expect(await maintenance.inspectConfigurationMaintenance(identity)).toMatchObject({
              state: "prepared",
              preflight: "unavailable",
              sequence: prepared.sequence,
            });
          } else {
            const nativeFetch = globalThis.fetch;
            let dropped = false;
            const transport = vi
              .spyOn(globalThis, "fetch")
              .mockImplementation(async (input, options) => {
                const response = await nativeFetch(input, options);
                if (
                  !dropped &&
                  typeof options?.body === "string" &&
                  JSON.parse(options.body).operation?.kind === "configurationMaintenance.inspect"
                ) {
                  expect(response.status).toBe(200);
                  dropped = true;
                  await response.arrayBuffer();
                  throw new TypeError("Named inspection response loss");
                }
                return response;
              });
            try {
              await expect(
                maintenance.inspectConfigurationMaintenance(identity),
              ).rejects.toBeInstanceOf(
                (await import("../admin-job-failure")).JobObservationPending,
              );
              expect(dropped).toBe(true);
            } finally {
              transport.mockRestore();
            }
            expect(await maintenance.inspectConfigurationMaintenance(identity)).toMatchObject({
              state: "prepared",
              preflight: "current",
              sequence: prepared.sequence,
            });
          }
          expect(dm!.preparePosts).toBe(1);
          expect(
            host.calls.filter(
              (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
            ),
          ).toHaveLength(beforeLifecycle);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
        });
      },
      60000,
    );
    it("inspects actual durable nonempty maintenance on the same owned desired-write transaction connection", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "ensure-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-transaction-inspection",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          identity = {
            maintenanceId: prepared.binding.maintenanceId,
            candidateId: candidate.candidateId,
          };
        let pending: ReturnType<typeof maintenance.inspectConfigurationMaintenance> | undefined,
          timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await writer
            .withConfigurationWriteTransaction(
              writer.currentAdministrativeConfigurationWriter(),
              async (tx) => {
                pending = maintenance.inspectConfigurationMaintenance(identity);
                const receipt = await Promise.race([
                  pending,
                  new Promise<never>((_resolve, reject) => {
                    timer = setTimeout(
                      () => reject(Error("Inspection blocked by its own owned job row lock")),
                      5000,
                    );
                  }),
                ]);
                expect(receipt).toMatchObject({
                  state: "prepared",
                  preflight: "current",
                  sequence: prepared.sequence,
                });
                const [row] = await tx
                  .select()
                  .from(schema.adminJob)
                  .where(eq(schema.adminJob.id, ctx.jobId));
                expect(row?.result).toMatchObject({
                  _configurationMaintenance: { inspection: { state: "complete", receipt } },
                });
              },
            )
            .catch((error) => {
              if (error instanceof writer.ConfigurationWriteRolledBack) throw error.failure;
              throw error;
            });
        } finally {
          if (timer) clearTimeout(timer);
          // A RED observer timeout releases the actual SQL row lock before
          // awaiting that original read; no unobserved background task remains.
          await pending?.catch(() => undefined);
        }
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(dm!.preparePosts).toBe(1);
      });
    }, 60000);
    it.each([false, true])(
      "commits a durable nonempty maintenance desired-row and continue decision in one actual transaction with rollback=%s",
      async (rollback) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "ensure-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-committed-maintenance-credential",
                  },
                ],
              },
            }),
            maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            lifecycle = host.calls.filter(
              (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
            ).length;
          if (rollback) {
            // An actual owned-PG constraint fails the desired write; no authority,
            // transaction runner, verifier or proof result is substituted.
            await fixture.sql`ALTER TABLE service_secret ADD CONSTRAINT fixture_reject_desired_token CHECK (key <> 'TOKEN')`;
            await expect(
              prospective.commitProspectiveConfigurationMaintenance(candidate),
            ).rejects.toBeInstanceOf(writer.ConfigurationWriteRolledBack);
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            const [row] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, ctx.jobId));
            expect(row?.result).not.toHaveProperty("_configurationMaintenanceDecision");
            expect(row?.result).toMatchObject({
              _configurationCandidate: { phase: "rolled_back" },
              _configurationMaintenanceRollback: {
                disposition: "known_rolled_back",
                candidateId: candidate.candidateId,
                maintenanceId: prepared.binding.maintenanceId,
              },
            });
            await expect(
              ctx.checkpoint({
                ...ctx.checkpointResult,
                _configurationMaintenanceRollback: {
                  ...(ctx.checkpointResult!._configurationMaintenanceRollback as Record<
                    string,
                    unknown
                  >),
                  rollbackId: randomUUID(),
                },
              }),
            ).rejects.toThrow("Known maintenance rollback changed outside its fixed producer");
          } else {
            const decision = await prospective.commitProspectiveConfigurationMaintenance(candidate),
              [saved] =
                await fixture.sql`SELECT id,xmin::text AS version FROM service_secret WHERE service_id='data-manager' AND key='TOKEN'`,
              [row] = await fixture.db
                .select()
                .from(schema.adminJob)
                .where(eq(schema.adminJob.id, ctx.jobId));
            expect(saved).toBeDefined();
            expect(decision).toMatchObject({
              decision: "continue",
              expectedSequence: prepared.sequence,
              prepareOperationKey: prepared.prepare.operationKey,
              planDigest: prepared.planDigest,
            });
            const versions = [
              {
                kind: "service-secret",
                ownerId: "data-manager",
                key: "TOKEN",
                rowId: saved!.id,
                rowVersion: saved!.version,
                previousRowVersion: null,
                state: "present",
              },
            ];
            expect(row?.result).toMatchObject({
              _configurationCandidate: { phase: "saved", rowVersions: versions },
              _configurationMaintenanceDecision: {
                version: 1,
                operation: decision,
                rowVersions: versions,
                attempt: "not_attempted",
              },
            });
            expect(JSON.stringify(row?.result)).not.toContain(
              "synthetic-committed-maintenance-credential",
            );
            expect(await prospective.commitProspectiveConfigurationMaintenance(candidate)).toEqual(
              decision,
            );
            const authorized = await maintenance.decideConfigurationMaintenance(decision);
            expect(authorized).toMatchObject({
              state: "authorized",
              decision: { decision: "continue", decisionId: decision.decisionId },
              generation: "not_started",
              followUp: "not_started",
              dmFence: prepared.dmFence,
            });
            const { configurationMaintenanceSettleRequestDigest } = await import(
                "@openmapx/core/ops"
              ),
              store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
              authority = restoreAdmittedControlExecution(installation, prepared.prepare);
            expect(configurationMaintenanceSettleRequestDigest(authorized)).toBe(
              configurationMaintenanceSettleRequestDigest(
                store.readOwnedConfigurationMaintenance(authority).receipt,
              ),
            );
          }
          expect(dm!.preparePosts).toBe(1);
          expect(
            host.calls.filter(
              (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
            ),
          ).toHaveLength(lifecycle);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
        });
      },
      60000,
    );
    it("closes actual durable nonempty known rolled-back current persistence as unused and releases the next writer", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
          actorId: ctx.jobId,
          operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
          expectedCurrentRevisionId: host.initial.revisionId,
          followUp: "service-apply",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "require-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "data-manager",
                key: "TOKEN",
                action: "set",
                value: "synthetic-rollback-unused-credential",
              },
            ],
          },
        });
        await fixture.sql`ALTER TABLE service_secret ADD CONSTRAINT fixture_reject_desired_token CHECK (key <> 'TOKEN')`;
        const result = await prospective
          .persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          })
          .then(({ application }) => ({ outcome: application }));
        expect(result.outcome).toMatchObject({ outcome: "not_committed", reason: "conflict" });
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(ctx.checkpointResult).toMatchObject({
          _configurationCandidate: { phase: "discarded" },
          _configurationMaintenanceDecision: {
            operation: { decision: "abandon" },
            rowVersions: [],
          },
          _configurationMaintenance: {
            phase: "settled",
            receipt: {
              state: "settled",
              generation: "not_started",
              followUp: "not_started",
              dmFence: { state: "settled" },
            },
          },
        });
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
        expect(JSON.stringify(ctx.checkpointResult)).not.toContain(
          "synthetic-rollback-unused-credential",
        );
      });
      const next = await job();
      await owned(next, async () =>
        expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
      );
    }, 120000);
    it("commits the actual durable nonempty frozen generation child under its original maintenance owner", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "ensure-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-frozen-generation-credential",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          decision = await prospective.commitProspectiveConfigurationMaintenance(candidate);
        await maintenance.decideConfigurationMaintenance(decision);
        const calls = host.calls.length,
          core = await import("@openmapx/core/build-artifacts"),
          authority = restoreAdmittedControlExecution(installation, prepared.prepare),
          lease = core.restoreArtifactTargetLeaseForSettlement(authority),
          ownerRecord = () => JSON.stringify(heldLease(host.infraDir, lease.leaseId)),
          ownerBytes = ownerRecord(),
          originalAdmissionPath = join(
            host.infraDir,
            "state/ops-agent/control/executions",
            `${prepared.prepare.operationKey}.json`,
          ),
          originalAdmission = readFileSync(originalAdmissionPath);
        core.closeArtifactTargetLeaseHandle(lease);
        const nativeFetch = globalThis.fetch,
          admissions: { status: number; errorClass?: string }[] = [],
          transportProbe = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
            const response = await nativeFetch(...args);
            if (String(args[0]).endsWith("/v1/operations") && args[1]?.method === "POST") {
              const frame = (await response.clone().json()) as { error?: { class?: string } };
              admissions.push({ status: response.status, errorClass: frame.error?.class });
            }
            return response;
          });
        let result: unknown;
        try {
          result = await maintenance.executeConfigurationMaintenanceStep(candidate, 0);
        } catch (error) {
          const store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
            actual = store.readOwnedConfigurationMaintenance(authority),
            slot = actual.plan.reservations[0]!,
            bound = lookupControlChildPhaseBinding(authority, slot),
            attempt = lookupControlChildPhaseAttempt(authority, slot),
            journal = await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json")),
            record = journal
              .records()
              .find((value) => value.operationKey === prepared.steps[0]!.operationKey);
          throw Error(
            `${(error as Error).name}; actual admission frames=${JSON.stringify(admissions)}; phase=${JSON.stringify(
              {
                bound: Boolean(bound),
                issued: Boolean(attempt),
                actorSlots: actual.apiControls.steps.length,
                actorGrant: Boolean(actual.apiControls.steps[0]?.grant),
                journalState: record?.state,
                adoption: record?.controlAdoption?.phase,
                state: actual.receipt.state,
                sequence: actual.sequence,
                generationCommitted:
                  services.currentConfigurationGeneration(host.infraDir) === candidate.revisionId,
              },
            )}`,
          );
        } finally {
          transportProbe.mockRestore();
        }
        expect(result).toMatchObject({ outcome: "committed", revisionId: candidate.revisionId });
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(candidate.revisionId);
        expect(
          host.calls
            .slice(calls)
            .some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
        ).toBe(false);
        expect(dm!.preparePosts).toBe(1);
        // The root lease still names the same owner and targets.
        const after = heldLease(host.infraDir, lease.leaseId),
          before = JSON.parse(ownerBytes);
        expect(after?.owner).toEqual(before.owner);
        expect(after?.targets).toEqual(before.targets);
        expect(readFileSync(originalAdmissionPath)).toEqual(originalAdmission);
        const step = prepared.steps[0]!,
          projected = (await import("../admin-job-ops")).readProjection(
            ctx.protocol,
            ctx.checkpointResult,
          ).operations[step.operationKey];
        expect(projected).toMatchObject({
          operation: step.operation,
          operationKey: step.operationKey,
          terminal: true,
          result: { outcome: "committed", revisionId: candidate.revisionId },
          receiptDelivery: expect.anything(),
        });
        expect(await maintenance.executeConfigurationMaintenanceStep(candidate, 0)).toEqual(result);
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
      });
    }, 60000);
    it.each([false, true])(
      "applies the actual durable nonempty maintenance hardlink middle owner and its sole DM leaf (recreate=%s)",
      async (recreate) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
        const ctx = await job(),
          observation = new AbortController();
        ctx.signal = observation.signal;
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "require-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-maintenance-hardlink-credential",
                  },
                ],
              },
            }),
            maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            decision = await prospective.commitProspectiveConfigurationMaintenance(candidate);
          await maintenance.decideConfigurationMaintenance(decision);
          await maintenance.executeConfigurationMaintenanceStep(candidate, 0);
          const step = prepared.steps[1]!;
          expect(step).toMatchObject({
            phase: "maintenance-hardlinks",
            ordinal: 1,
            prerequisites: [0],
            operation: { kind: "configuration.hardlinks.apply" },
          });
          // Bound this test's observer only. If the real protocol deliberately
          // retains an unknown, cancel/await that SAME attempted observation before
          // fixture teardown instead of abandoning a timed-out API/SQL scope.
          const observer = setTimeout(() => {
            const journal = JSON.parse(
              readFileSync(join(host.infraDir, "state/ops-agent/jobs-v1.json"), "utf8"),
            );
            console.info(
              JSON.stringify({
                proof: "actual-maintenance-middle-owner-observation",
                dmPosts: dm!.posts,
                dmResponses: dm!.hardlinkResponseStatuses,
                jobs: journal.jobs
                  .filter(
                    (value: { operation: { maintenanceId?: string } }) =>
                      value.operation.maintenanceId === prepared.binding.maintenanceId,
                  )
                  .map(
                    (value: {
                      operation: { kind: string };
                      state: string;
                      errorClass?: string;
                      controlAdoption?: { phase: string };
                    }) => ({
                      kind: value.operation.kind,
                      state: value.state,
                      errorClass: value.errorClass,
                      adoption: value.controlAdoption?.phase,
                    }),
                  ),
              }),
            );
            observation.abort();
          }, 45000);
          let result: unknown;
          try {
            result = await maintenance.executeConfigurationMaintenanceStep(candidate, 1);
          } finally {
            clearTimeout(observer);
          }
          expect(result).toMatchObject({
            applied: true,
            entries: 1,
            linked: 1,
            via: "data-manager",
          });
          expect(dm!.posts).toBe(1);
          expect(dm!.preparePosts).toBe(1);
          const plan = JSON.parse(
              readFileSync(
                services.currentConfigurationFile(
                  host.infraDir,
                  services.GENERATED_HARDLINK_PLAN_FILE,
                ),
                "utf8",
              ),
            ),
            target = join(host.infraDir, plan[0].target, "fixture.pbf"),
            projected = (await import("../admin-job-ops")).readProjection(
              ctx.protocol,
              ctx.checkpointResult,
            ).operations[step.operationKey];
          expect(statSync(target).ino).toBe(statSync(join(source, "fixture.pbf")).ino);
          expect(projected).toMatchObject({
            operation: step.operation,
            terminal: true,
            receiptDelivery: expect.anything(),
          });
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
          expect(heldTargets(host.infraDir).includes("motis")).toBe(true);
          if (recreate) {
            expect(prepared.steps[2]).toMatchObject({
              phase: "maintenance-recreate",
              prerequisites: [1],
              operation: { kind: "service.recreate", serviceId: "data-manager" },
            });
            const timer = setTimeout(() => observation.abort(), 45000);
            try {
              expect(await maintenance.executeConfigurationMaintenanceStep(candidate, 2)).toEqual({
                changed: true,
              });
            } finally {
              clearTimeout(timer);
            }
            const after = await maintenance.inspectConfigurationMaintenance(prepared.binding);
            expect(after).toMatchObject({
              generation: "committed",
              followUp: "complete",
              state: "applying",
            });
            expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
          }
        });
      },
      120000,
    );
    it("records a durable nonempty maintenance step terminal on agent restart after its owner write was lost", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const source = join(host.infraDir, "data/source-osm");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
      const ctx = await job(),
        observation = new AbortController();
      ctx.signal = observation.signal;
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "require-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-maintenance-step-restart-credential",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
          { AnchoredDirectory } = await import(
            "../../../../../packages/core/src/build-artifacts/filesystem"
          ),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          decision = await prospective.commitProspectiveConfigurationMaintenance(candidate);
        await maintenance.decideConfigurationMaintenance(decision);
        await maintenance.executeConfigurationMaintenanceStep(candidate, 0);
        const step = prepared.steps[1]!,
          canonical = () =>
            store
              .readOwnedConfigurationMaintenance(
                restoreAdmittedControlExecution(installation, prepared.prepare),
              )
              .apiControls.steps.find((value) => value.execution.operationKey === step.operationKey)
              ?.canonical ?? null;
        // The agent journals the step's terminal, then stops before the owner
        // record carries it: fail exactly that owner write once.
        const write = AnchoredDirectory.prototype.write;
        let lost = false;
        const fault = vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
          this: InstanceType<typeof AnchoredDirectory>,
          ...args
        ) {
          const [name, bytes] = args;
          if (!lost && name === `${prepared.binding.maintenanceId}.json`) {
            const recorded = (
              JSON.parse(String(bytes)) as {
                apiControls?: {
                  steps?: { execution: { operationKey: string }; canonical: unknown }[];
                };
              }
            )?.apiControls?.steps?.find(
              (value) => value.execution.operationKey === step.operationKey,
            );
            if (recorded?.canonical) {
              lost = true;
              throw Error("Synthetic agent stop before the step terminal reached its owner");
            }
          }
          return write.apply(this, args);
        });
        const timer = setTimeout(() => observation.abort(), 45000);
        try {
          await maintenance
            .executeConfigurationMaintenanceStep(candidate, 1)
            .catch(() => undefined);
        } finally {
          clearTimeout(timer);
          fault.mockRestore();
        }
        expect(lost).toBe(true);
        expect(canonical()).toBeNull();
        await app.close();
        closeControlInstallation(installation);
        const journal = await openOpsJobJournal(
          join(host.infraDir, "state/ops-agent/jobs-v1.json"),
        );
        expect(
          journal.records().find((value) => value.operationKey === step.operationKey)?.state,
        ).toBe("succeeded");
        installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: host.loaded.map((value) => value.manifest.id),
        });
        const restartedRuntime = await host.reopenRuntime();
        app = buildOpsAgentServer({
          tokens: {
            api: host.token,
            "data-manager": Buffer.alloc(32, 23).toString("base64url"),
          },
          runtime: restartedRuntime,
          resourceClaimer: host.createResourceClaimer(restartedRuntime),
          journal,
          controlInstallation: installation,
        });
        vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
        expect(canonical()).not.toBeNull();
      });
    }, 120000);
    it.each(["contained", "retirement", "pointer-ack-loss"])(
      "settles the actual durable nonempty contained final after a known native generation noncommit through the current persister (mode=%s)",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const args = services.stackComposeArgs(host.stack),
          signal = new AbortController().signal,
          options = { signal, timeout: 15000, maxBuffer: 1024 * 1024 },
          config = JSON.parse(
            (await host.execFile("docker", [...args, "config", "--format", "json"], options))
              .stdout,
          ),
          hash = (
            await host.execFile("docker", [...args, "config", "--hash", "data-manager"], options)
          ).stdout
            .trim()
            .split(/\s+/)
            .at(-1)!,
          row = {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: {
              ...host.row.Labels,
              "com.docker.compose.service": "data-manager",
              "com.docker.compose.config-hash": hash,
            },
          },
          spec = config.services["data-manager"];
        host.setRows([host.row, row]);
        host.setRuntimeInspections({
          [row.Id]: {
            Id: row.Id,
            Image: row.Image,
            State: { Status: "running", Running: true, Health: { Status: "healthy" } },
            Config: {
              Image: row.ConfigImage,
              Labels: row.Labels,
              Env: Object.entries(spec.environment ?? {}).map(([key, value]) => `${key}=${value}`),
            },
            Mounts: (spec.volumes ?? []).map(
              (value: { source: string; target: string; type: string; read_only?: boolean }) => ({
                Type: value.type,
                Source: value.source,
                Destination: value.target,
                RW: !value.read_only,
              }),
            ),
          },
        });
        const ctx = await job(),
          observer = new AbortController();
        ctx.signal = observer.signal;
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "require-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-contained-candidate-credential",
                  },
                ],
              },
            }),
            nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
          let faults = 0;
          const fault = vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
              if (
                (mode === "pointer-ack-loss"
                  ? String(target) === join(host.infraDir, services.CURRENT_CONFIGURATION)
                  : basename(String(target)) === candidate.revisionId) &&
                basename(String(source)).endsWith(".tmp")
              ) {
                if (mode === "pointer-ack-loss") nativeRename(source, target);
                faults++;
                throw Error("Injected actual generation rename refusal before pointer commit");
              }
              return nativeRename(source, target);
            }),
            timeout = setTimeout(() => observer.abort(), 90000);
          let result: Awaited<
            ReturnType<typeof prospective.persistAndApplyProspectiveConfiguration>
          >;
          if (mode === "pointer-ack-loss") {
            try {
              await expect(
                prospective.persistAndApplyProspectiveConfiguration(candidate, {
                  coordinatorMode: "require-running",
                  signal: ctx.signal,
                }),
              ).rejects.toBeInstanceOf(Error);
            } finally {
              clearTimeout(timeout);
              fault.mockRestore();
            }
            expect(faults).toBe(1);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              candidate.revisionId,
            );
            expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
            const retained = (
                ctx.checkpointResult!._configurationMaintenance as {
                  receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
                }
              ).receipt,
              store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
              owner = store.readOwnedConfigurationMaintenance(
                restoreAdmittedControlExecution(installation, retained.prepare),
              );
            expect(owner.final).toBeNull();
            expect(owner.inspection).toBeNull();
            expect(owner.receipt.dmFence!.state).toBe("prepared");
            expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
            await expect(dm!.receiver.admitLocal({ kind: "download-fonts" })).rejects.toThrow(
              "configuration_maintenance_busy",
            );
            expect(
              host.calls.some(
                (value) =>
                  value.includes("up") || value.includes("pull") || value.includes("restart"),
              ),
            ).toBe(false);
            return;
          }
          try {
            result = await prospective.persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode: "require-running",
              signal: ctx.signal,
            });
          } finally {
            clearTimeout(timeout);
            fault.mockRestore();
          }
          expect(faults).toBe(1);
          expect(result).toMatchObject({
            saved: "committed",
            application: { outcome: "not_committed", reason: "failed", cleanupFailed: false },
          });
          expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          const receipt = (
              ctx.checkpointResult!._configurationMaintenance as {
                receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
              }
            ).receipt,
            store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
            owner = store.readOwnedConfigurationMaintenance(
              restoreAdmittedControlExecution(installation, receipt.prepare),
            );
          expect(owner.final).toMatchObject({
            ownerFinal: { payload: { outcome: "contained" } },
            evidence: {
              outcome: "contained",
              generation: { state: "not_committed" },
              followUp: { state: "contained" },
            },
          });
          expect(owner.receipt).toMatchObject({
            state: "settled",
            generation: "not_committed",
            followUp: "contained",
            dmFence: { state: "settled" },
          });
          expect(owner.apiControls.steps).toHaveLength(1);
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
          expect(
            existsSync(join(host.candidates, `${owner.plan.operation.applyOperationKey}.json`)),
          ).toBe(false);
          expect(
            host.calls.some(
              (value) =>
                value.includes("up") || value.includes("pull") || value.includes("restart"),
            ),
          ).toBe(false);
          if (mode === "retirement") {
            // Past every timed key's expiry (at most seven days ahead) plus the
            // 72-hour prune delay.
            const later = Date.now() + (7 * 24 + 96) * 3600000;
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(later);
            try {
              // A restarted agent first drops journal entries past their
              // retention, then prunes the records nothing references.
              await app.close();
              closeControlInstallation(installation);
              const journal = await openOpsJobJournal(
                join(host.infraDir, "state/ops-agent/jobs-v1.json"),
              );
              installation = openControlInstallation({
                infraDir: host.infraDir,
                role: "ops-agent",
                serviceIds: host.loaded.map((value) => value.manifest.id),
              });
              const restartedRuntime = await host.reopenRuntime();
              app = buildOpsAgentServer({
                tokens: {
                  api: host.token,
                  "data-manager": Buffer.alloc(32, 23).toString("base64url"),
                },
                runtime: restartedRuntime,
                resourceClaimer: host.createResourceClaimer(restartedRuntime),
                journal,
                controlInstallation: installation,
              });
              vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
              expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
              expect(
                journal
                  .records()
                  .some(
                    (value) =>
                      (value.operation.kind === "configurationMaintenance.decide" ||
                        value.operation.kind === "configurationMaintenance.settle") &&
                      value.operation.prepareOperationKey === owner.plan.prepare.operationKey,
                  ),
              ).toBe(false);
              expect(
                existsSync(
                  join(
                    host.infraDir,
                    "state/ops-agent/control/executions",
                    `${owner.plan.prepare.operationKey}.json`,
                  ),
                ),
              ).toBe(false);
              await dm!.pruneRecords(later);
              expect(
                await fixture.sql`SELECT maintenance_id FROM data_manager.configuration_fence WHERE fence_id=${owner.preparedFence!.fenceId}::uuid`,
              ).toEqual([]);
              await dm!.close();
              dm = await ownedDataManager({
                sql: fixture.sql,
                infraDir: host.infraDir,
                serviceIds: host.loaded.map((value) => value.manifest.id),
              });
              vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
              expect(
                (
                  await fetch(`${dm.baseUrl}/status`, {
                    headers: { authorization: `Bearer ${dm.token}` },
                  })
                ).status,
              ).toBe(200);
            } finally {
              vi.useRealTimers();
            }
          }
        });
        const next = await job();
        if (mode === "pointer-ack-loss")
          await expect(owned(next, async () => undefined)).rejects.toThrow(
            "Configuration writer unavailable",
          );
        else
          await owned(next, async () =>
            expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
          );
      },
      120000,
    );
    it.each(["component", "outer-api", "persister", "lost-settle-reply", "retirement"])(
      "constructs the actual durable nonempty applied final from production runtime configuration, mounts, image and readiness (mode=%s)",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
          loseSettleResponseOnce: mode === "lost-settle-reply",
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const dmRow = {
          ...host.row,
          Id: "c".repeat(64),
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        host.setRows([host.row, dmRow]);
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "require-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-applied-final-credential",
                  },
                ],
              },
            }),
            maintenance = await import("../configuration-maintenance");
          let installedDocker: Parameters<typeof host.setRuntimeInspections>[0] = {};
          host.setCreatingProcess(async () => {
            const args = services.stackComposeArgs(host.stack),
              signal = new AbortController().signal,
              options = { signal, timeout: 15000, maxBuffer: 1024 * 1024 },
              config = JSON.parse(
                (await host.execFile("docker", [...args, "config", "--format", "json"], options))
                  .stdout,
              ),
              hash = (
                await host.execFile(
                  "docker",
                  [...args, "config", "--hash", "data-manager"],
                  options,
                )
              ).stdout
                .trim()
                .split(/\s+/)
                .at(-1)!,
              compose = services.configurationGenerationComposeFile(
                host.infraDir,
                candidate.revisionId,
              ),
              row = {
                ...dmRow,
                Id: "d".repeat(64),
                Labels: {
                  ...dmRow.Labels,
                  "com.docker.compose.project.working_dir": dirname(compose),
                  "com.docker.compose.project.config_files": compose,
                  "com.docker.compose.config-hash": hash,
                },
              },
              service = config.services["data-manager"];
            host.setRows([host.row, row]);
            installedDocker = {
              [row.Id]: {
                Id: row.Id,
                Image: row.Image,
                State: { Status: "running", Running: true, Health: { Status: "healthy" } },
                Config: {
                  Image: row.ConfigImage,
                  Labels: row.Labels,
                  Env: Object.entries(service.environment ?? {}).map(
                    ([key, value]) => `${key}=${value}`,
                  ),
                },
                Mounts: [
                  ...(service.volumes ?? []).map(
                    (value: {
                      source: string;
                      target: string;
                      type: string;
                      read_only?: boolean;
                    }) => ({
                      Type: value.type,
                      Source: value.source,
                      Destination: value.target,
                      RW: !value.read_only,
                    }),
                  ),
                  ...(service.secrets ?? []).map((value: { source: string; target: string }) => ({
                    Type: "bind",
                    Source: config.secrets[value.source].file,
                    Destination: `/run/secrets/${value.target}`,
                    RW: false,
                  })),
                ],
              },
            };
            host.setRuntimeInspections(installedDocker);
          });
          let prepared: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
          let decisionId: string;
          if (mode === "persister" || mode === "lost-settle-reply" || mode === "retirement") {
            const application = prospective
              .persistAndApplyProspectiveConfiguration(candidate, {
                coordinatorMode: "require-running",
                signal: ctx.signal,
              })
              .then(({ application }) => ({ outcome: application }));
            void application.catch(() => {});
            const result = await application;
            expect(result.outcome).toMatchObject({
              outcome: "committed",
              revisionId: candidate.revisionId,
              followUp: "complete",
            });
            const ops = await import("@openmapx/core/ops");
            prepared = ops.configurationMaintenanceReceiptSchema.parse(
              (ctx.checkpointResult!._configurationMaintenance as Record<string, unknown>).receipt,
            );
            decisionId = prepared.decision!.decisionId;
            expect(
              (ctx.checkpointResult!._configurationCandidate as Record<string, unknown>).phase,
            ).toBe("settled");
            expect(
              existsSync(join(host.candidates, `${prepared.binding.applyOperationKey}.json`)),
            ).toBe(false);
          } else {
            prepared = await maintenance.prepareConfigurationMaintenance(candidate);
            const decision = await prospective.commitProspectiveConfigurationMaintenance(candidate);
            decisionId = decision.decisionId;
            await maintenance.decideConfigurationMaintenance(decision);
            await maintenance.executeConfigurationMaintenanceStep(candidate, 0);
            await maintenance.executeConfigurationMaintenanceStep(candidate, 1);
            await maintenance.executeConfigurationMaintenanceStep(candidate, 2);
          }
          const authority = restoreAdmittedControlExecution(installation, prepared.prepare),
            runtime = await import("../../../../ops-agent/src/configuration-maintenance-runtime"),
            store = await import("../../../../ops-agent/src/configuration-maintenance-store");
          if (mode === "outer-api") {
            const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
              ops = await import("@openmapx/core/ops");
            const result = await maintenance.settleConfigurationMaintenance({
              kind: "configurationMaintenance.settle",
              maintenanceId: prepared.binding.maintenanceId,
              candidateId: candidate.candidateId,
              prepareOperationKey: prepared.prepare.operationKey,
              prepareFingerprint: prepared.prepare.operationFingerprint,
              planDigest: prepared.planDigest,
              decisionId,
              expectedSequence: observed.sequence,
              evidenceDigest: ops.configurationMaintenanceSettleRequestDigest(observed),
            });
            expect(result).toMatchObject({
              state: "settled",
              generation: "committed",
              appliedRevisionId: candidate.revisionId,
              followUp: "complete",
              dmFence: { state: "settled" },
            });
            expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
          } else if (mode === "component") {
            const shapes = await import(
                "../../../../../packages/core/src/build-artifacts/configuration-maintenance-docker-records"
              ),
              id = "d".repeat(64),
              original = shapes.maintenanceDockerContainerSchema.parse(installedDocker[id]),
              path = join(
                host.infraDir,
                "state/ops-agent/control/configuration-maintenance",
                `${prepared.binding.maintenanceId}.json`,
              ),
              before = readFileSync(path);
            for (const mismatch of [
              "hash",
              "environment",
              "image",
              "mount",
              "secret",
              "readiness",
            ] as const) {
              const changed = structuredClone(original),
                secret = changed.Mounts.find((value) =>
                  value.Destination.startsWith("/run/secrets/"),
                )!;
              if (mismatch === "hash")
                changed.Config.Labels["com.docker.compose.config-hash"] = "0".repeat(64);
              if (mismatch === "environment")
                changed.Config.Env = changed.Config.Env.map((value) =>
                  value.startsWith("TOKEN_FILE=") ? "TOKEN_FILE=/unexpected" : value,
                );
              if (mismatch === "image") changed.Image = `sha256:${"0".repeat(64)}`;
              if (mismatch === "mount") secret.Source = host.firstCompose;
              if (mismatch === "secret")
                host.setRuntimeSecretBytes({
                  [`${id}:${secret.Destination}`]:
                    Buffer.from("stale-runtime-secret").toString("base64"),
                });
              if (mismatch === "readiness") changed.State.Health = { Status: "unhealthy" };
              host.setRuntimeInspections({ [id]: changed });
              let refused = false;
              try {
                await runtime.inspectFrozenMaintenanceRuntime(
                  host.runtime,
                  authority,
                  new AbortController().signal,
                );
              } catch {
                refused = true;
              } finally {
                host.setRuntimeInspections(installedDocker);
                host.setRuntimeSecretBytes({});
              }
              console.info(
                JSON.stringify({ proof: "actual-runtime-mismatch-refusal", mismatch, refused }),
              );
              expect(refused, `Actual runtime mismatch accepted: ${mismatch}`).toBe(true);
              expect(readFileSync(path)).toEqual(before);
            }
            const inspection = await runtime.inspectFrozenMaintenanceRuntime(
              host.runtime,
              authority,
              new AbortController().signal,
            );
            expect(store.finalizeOwnedMaintenanceState(authority, inspection)).toBeDefined();
          }
          const owner = store.readOwnedConfigurationMaintenance(authority);
          if (mode !== "component") {
            expect(owner.receipt).toMatchObject({
              state: "settled",
              dmFence: { state: "settled" },
            });
            expect(await dm!.fenceStates()).toEqual(["settled"]);
            if (mode === "lost-settle-reply")
              expect(dm!.settlementResponseStatuses).toEqual([200, 200]);
          }
          expect(owner.final).toMatchObject({
            ownerFinal: { payload: { outcome: "applied" } },
            evidence: {
              outcome: "applied",
              generation: { state: "committed", revisionId: candidate.revisionId },
              followUp: { state: "complete" },
              runtime: { mode: "applied" },
            },
          });
          expect(owner.final!.evidence.children).toHaveLength(4);
          expect(owner.inspection!.requiredChecks.map((check) => check.check)).toEqual(
            expect.arrayContaining(["configuration", "image", "mount", "readiness"]),
          );
          expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
          if (mode === "retirement") {
            const core = await import("@openmapx/core/build-artifacts"),
              later = Math.max(Date.now(), owner.origin.notAfter) + 96 * 3600000,
              clock = vi.spyOn(Date, "now").mockReturnValue(later);
            try {
              expect(await core.pruneControlRecords(installation, { now: later })).toContain(
                owner.plan.prepare.operationKey,
              );
              await dm!.pruneRecords(later);
              expect(
                await fixture.sql`SELECT maintenance_id FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`,
              ).toEqual([]);
              expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
                candidate.revisionId,
              );
            } finally {
              clock.mockRestore();
            }
          }
        });
      },
      180000,
    );
    it.each(["expired", "host-source"])(
      "refuses actual durable nonempty committed continue after %s drift without admitting any effect",
      async (reason) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        try {
          await owned(ctx, async () => {
            const candidate = await prospective.prepareProspectiveConfiguration({
                actorId: ctx.jobId,
                operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
                expectedCurrentRevisionId: host.initial.revisionId,
                followUp: "service-apply",
                overlay: {
                  purpose: "service-secret",
                  coordinatorMode: "ensure-running",
                  changes: [
                    {
                      kind: "service-secret",
                      serviceId: "data-manager",
                      key: "TOKEN",
                      action: "set",
                      value: "synthetic-committed-drift-credential",
                    },
                  ],
                },
              }),
              maintenance = await import("../configuration-maintenance"),
              prepared = await maintenance.prepareConfigurationMaintenance(candidate),
              decision = await prospective.commitProspectiveConfigurationMaintenance(candidate),
              beforeCalls = host.calls.length;
            if (reason === "expired") {
              vi.useFakeTimers({ toFake: ["Date"] });
              vi.setSystemTime(Date.now() + 6 * 60000);
            } else
              writeFileSync(join(host.infraDir, ".env"), "MOTIS_SLOT_MEMORY=8g\n", { mode: 0o600 });
            await expect(maintenance.decideConfigurationMaintenance(decision)).rejects.toThrow();
            const store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
              actual = store.readOwnedConfigurationMaintenance(
                restoreAdmittedControlExecution(installation, prepared.prepare),
              );
            expect(actual.apiControls.decide).toBeNull();
            expect(actual.receipt).toMatchObject({
              state: "prepared",
              decision: null,
              dmFence: prepared.dmFence,
              generation: "not_started",
              followUp: "not_started",
            });
            expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(
              host.calls
                .slice(beforeCalls)
                .some(
                  (args) =>
                    args.includes("up") || args.includes("pull") || args.includes("restart"),
                ),
            ).toBe(false);
            expect(dm!.preparePosts).toBe(1);
            expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
          });
        } finally {
          vi.useRealTimers();
        }
      },
      60000,
    );
    it.each(["checksum", "sequence", "decision", "candidate"])(
      "refuses actual durable nonempty outer settle %s before its first owner CAS",
      async (mismatch) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "require-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-settle-checksum-credential",
                  },
                ],
              },
            }),
            maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
          await maintenance.decideConfigurationMaintenance(decision);
          const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
            ops = await import("@openmapx/core/ops"),
            path = join(
              host.infraDir,
              "state/ops-agent/control/configuration-maintenance",
              `${prepared.binding.maintenanceId}.json`,
            ),
            before = readFileSync(path),
            operation = {
              kind: "configurationMaintenance.settle" as const,
              maintenanceId: prepared.binding.maintenanceId,
              candidateId: mismatch === "candidate" ? randomUUID() : candidate.candidateId,
              prepareOperationKey: prepared.prepare.operationKey,
              prepareFingerprint: prepared.prepare.operationFingerprint,
              planDigest: prepared.planDigest,
              decisionId: mismatch === "decision" ? randomUUID() : decision.decisionId,
              expectedSequence: observed.sequence + (mismatch === "sequence" ? 1 : 0),
              evidenceDigest:
                mismatch === "checksum"
                  ? "0".repeat(64)
                  : ops.configurationMaintenanceSettleRequestDigest(observed),
            };
          const nativeFetch = globalThis.fetch,
            frames: { status: number; errorClass?: string }[] = [],
            transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
              const response = await nativeFetch(...args);
              if (String(args[0]).endsWith("/v1/operations") && args[1]?.method === "POST") {
                const frame = (await response.clone().json()) as { error?: { class?: string } };
                frames.push({ status: response.status, errorClass: frame.error?.class });
              }
              return response;
            });
          try {
            // Faulty API producer negative: use the ACTUAL API issuer and durable
            // checkpoint, not a handwritten HMAC/grant or a weakened API adapter.
            const { prepareApiJobRoot, prepareApiJobChildAttempt, issueApiJobChildAssertion } =
                await import("../admin-job-parent"),
              { createDurableOpsKey, createApiOpsClient, executeAndWait } = await import(
                "../ops-client"
              ),
              root = prepareApiJobRoot(
                ctx,
                operation.kind,
                createDurableOpsKey("task012.settle-negative", ctx.jobId),
              ),
              attempt = prepareApiJobChildAttempt(ctx, operation, root.operationKey, root)!;
            await ctx.checkpoint({
              ...ctx.checkpointResult,
              _settleNegativeProbe: { operation, attempt, root },
            });
            await expect(
              executeAndWait(createApiOpsClient(), operation, root.operationKey, {
                execution: { requestedDeadlineAt: root.requestedDeadlineAt },
                parentAssertion: await issueApiJobChildAssertion(attempt),
              }),
            ).rejects.toBeInstanceOf(Error);
          } finally {
            transport.mockRestore();
          }
          expect(frames).toEqual([
            mismatch === "candidate"
              ? { status: 403, errorClass: "authorization" }
              : { status: 409, errorClass: "conflict" },
          ]);
          expect(readFileSync(path)).toEqual(before);
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
          expect(dm!.preparePosts).toBe(1);
        });
      },
      60000,
    );
    it("retains actual durable nonempty accepted but ineligible settle intent as unknown across agent restart with read-only health", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "require-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-ineligible-final-credential",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          decision = await prospective.commitProspectiveConfigurationMaintenance(candidate);
        await maintenance.decideConfigurationMaintenance(decision);
        const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
          ops = await import("@openmapx/core/ops"),
          request = {
            kind: "configurationMaintenance.settle" as const,
            maintenanceId: prepared.binding.maintenanceId,
            candidateId: candidate.candidateId,
            prepareOperationKey: prepared.prepare.operationKey,
            prepareFingerprint: prepared.prepare.operationFingerprint,
            planDigest: prepared.planDigest,
            decisionId: decision.decisionId,
            expectedSequence: observed.sequence,
            evidenceDigest: ops.configurationMaintenanceSettleRequestDigest(observed),
          },
          [beforeSql] =
            await fixture.sql`SELECT state,outcome,settled_at,xmin::text AS xmin FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`;
        await expect(maintenance.settleConfigurationMaintenance(request)).rejects.toBeInstanceOf(
          Error,
        );
        const store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
          authority = restoreAdmittedControlExecution(installation, prepared.prepare),
          actual = store.readOwnedConfigurationMaintenance(authority),
          accepted = actual.apiControls.settle!;
        expect(accepted).toMatchObject({
          operation: request,
          checkedSequence: observed.sequence,
          requestEvidenceDigest: request.evidenceDigest,
          result: null,
          canonicalDigest: null,
        });
        expect(actual.final).toBeNull();
        expect(actual.inspection).toBeNull();
        expect(actual.receipt).toMatchObject({
          state: "authorized",
          generation: "not_started",
          followUp: "not_started",
          dmFence: { state: "prepared" },
        });
        const path = join(
            host.infraDir,
            "state/ops-agent/control/configuration-maintenance",
            `${prepared.binding.maintenanceId}.json`,
          ),
          original = readFileSync(path);
        await app.close();
        closeControlInstallation(installation);
        const journal = await openOpsJobJournal(
          join(host.infraDir, "state/ops-agent/jobs-v1.json"),
        );
        installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        const restartedRuntime = await host.reopenRuntime();
        app = buildOpsAgentServer({
          tokens: {
            api: host.token,
            "data-manager": Buffer.alloc(32, 23).toString("base64url"),
          },
          runtime: restartedRuntime,
          resourceClaimer: host.createResourceClaimer(restartedRuntime),
          journal,
          controlInstallation: installation,
        });
        vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
        expect((await app.inject({ method: "GET", url: "/health" })).statusCode).toBe(200);
        const lookup = await app.inject({
          method: "GET",
          url: `/v1/operation-keys/${accepted.execution.operationKey}`,
          headers: {
            authorization: `Bearer ${host.token}`,
            "x-ops-request-id": randomUUID(),
            "x-ops-protocol-version": "2",
            "x-ops-body-fingerprint": accepted.execution.operationFingerprint,
            "x-ops-operation-fingerprint": accepted.execution.fingerprint,
          },
        });
        expect(lookup.statusCode).toBe(200);
        expect(lookup.json().result).toMatchObject({
          state: "failed",
          errorClass: "recovery_required",
          operationId: accepted.execution.executionId,
          operationKey: accepted.execution.operationKey,
          admittedAt: accepted.admittedAt,
          deadlineAt: accepted.execution.deadlineAt,
        });
        expect(readFileSync(path)).toEqual(original);
        expect(
          (
            await fixture.sql`SELECT state,outcome,settled_at,xmin::text AS xmin FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`
          )[0],
        ).toEqual(beforeSql);
        await expect(dm!.receiver.admitLocal({ kind: "download-fonts" })).rejects.toThrow(
          "configuration_maintenance_busy",
        );
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
      });
      const next = await job();
      await expect(owned(next, async () => undefined)).rejects.toThrow(
        "Configuration writer unavailable",
      );
    }, 120000);
    it.each(["expired", "canceled"])(
      "settles actual durable nonempty known-unused original ownership after the forward root is %s",
      async (condition) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        if (condition === "expired") {
          const { prepareApiJobRoot } = await import("../admin-job-parent"),
            initial = prepareApiJobRoot(
              ctx,
              "configurationMaintenance.prepare",
              "synthetic-initial-short-job-budget",
            );
          // Select a short INITIAL synthetic job lifetime, before any candidate or
          // root admission; all later HMACs/deadlines retain this original source.
          await ctx.checkpoint({
            ...ctx.checkpointResult,
            _parentExecution: { ...initial.parent, deadlineAt: Date.now() + 60000 },
          });
        }
        try {
          await owned(ctx, async () => {
            const candidate = await prospective.prepareProspectiveConfiguration({
                actorId: ctx.jobId,
                operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
                expectedCurrentRevisionId: host.initial.revisionId,
                followUp: "service-apply",
                overlay: {
                  purpose: "service-secret",
                  coordinatorMode: "require-running",
                  changes: [
                    {
                      kind: "service-secret",
                      serviceId: "data-manager",
                      key: "TOKEN",
                      action: "set",
                      value: "synthetic-late-unused-credential",
                    },
                  ],
                },
              }),
              maintenance = await import("../configuration-maintenance"),
              prepared = await maintenance.prepareConfigurationMaintenance(candidate),
              core = await import("@openmapx/core/build-artifacts"),
              authority = restoreAdmittedControlExecution(installation, prepared.prepare),
              admissionPath = join(
                host.infraDir,
                "state/ops-agent/control/executions",
                `${prepared.prepare.operationKey}.json`,
              ),
              originalAdmission = readFileSync(admissionPath);
            if (condition === "expired")
              await new Promise((resolve) =>
                setTimeout(resolve, Math.max(1, prepared.prepare.deadlineAt - Date.now() + 5)),
              );
            else {
              core.cancelControlExecution(authority);
              const lease = core.restoreArtifactTargetLeaseForSettlement(authority);
              try {
                await core.cancelArtifactTargetLease(lease);
              } finally {
                core.closeArtifactTargetLeaseHandle(lease);
              }
            }
            const decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
            await maintenance.decideConfigurationMaintenance(decision);
            const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
              ops = await import("@openmapx/core/ops"),
              request = {
                kind: "configurationMaintenance.settle" as const,
                maintenanceId: prepared.binding.maintenanceId,
                candidateId: candidate.candidateId,
                prepareOperationKey: prepared.prepare.operationKey,
                prepareFingerprint: prepared.prepare.operationFingerprint,
                planDigest: prepared.planDigest,
                decisionId: decision.decisionId,
                expectedSequence: observed.sequence,
                evidenceDigest: ops.configurationMaintenanceSettleRequestDigest(observed),
              },
              result = await maintenance.settleConfigurationMaintenance(request),
              retained = ctx.checkpointResult!._configurationMaintenanceSettle as {
                delivery: { root: { operationKey: string; requestedDeadlineAt: number } };
              },
              { createApiOpsClient } = await import("../ops-client"),
              lookup = await createApiOpsClient().lookup(
                request,
                retained.delivery.root.operationKey,
                { execution: { requestedDeadlineAt: retained.delivery.root.requestedDeadlineAt } },
              );
            expect(lookup).toMatchObject({
              state: "succeeded",
              result: { state: "settled", prepare: prepared.prepare },
            });
            await expect(
              createApiOpsClient().lookup(request, retained.delivery.root.operationKey, {
                execution: {
                  requestedDeadlineAt: retained.delivery.root.requestedDeadlineAt + 1,
                },
              }),
            ).rejects.toMatchObject({ errorClass: "conflict" });
            expect(result).toMatchObject({
              state: "settled",
              parentDeadlineAt: prepared.parentDeadlineAt,
              prepare: prepared.prepare,
              generation: "not_started",
              followUp: "not_started",
              dmFence: { state: "settled" },
            });
            expect(readFileSync(admissionPath)).toEqual(originalAdmission);
            expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
            expect(
              host.calls.some(
                (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
              ),
            ).toBe(false);
            expect(() => core.assertControlExecutionForward(authority)).toThrow();
          });
        } finally {
          vi.useRealTimers();
        }
      },
      120000,
    );
    it("repairs actual durable nonempty settle completion publication after root release without another inspection or SQL transition", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode: "require-running",
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-completion-publication-credential",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
        await maintenance.decideConfigurationMaintenance(decision);
        const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
          ops = await import("@openmapx/core/ops"),
          request = {
            kind: "configurationMaintenance.settle" as const,
            maintenanceId: prepared.binding.maintenanceId,
            candidateId: candidate.candidateId,
            prepareOperationKey: prepared.prepare.operationKey,
            prepareFingerprint: prepared.prepare.operationFingerprint,
            planDigest: prepared.planDigest,
            decisionId: decision.decisionId,
            expectedSequence: observed.sequence,
            evidenceDigest: ops.configurationMaintenanceSettleRequestDigest(observed),
          },
          nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs")).renameSync;
        let faults = 0;
        const originalSignal = ctx.signal,
          observer = new AbortController();
        ctx.signal = observer.signal;
        const fault = vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
          if (
            basename(String(target)) === `${prepared.binding.maintenanceId}.json` &&
            JSON.parse(readFileSync(source, "utf8"))?.apiControls?.settle?.result
          ) {
            faults++;
            observer.abort();
            throw Error("Injected native original completion publication failure");
          }
          return nativeRename(source, target);
        });
        try {
          await expect(maintenance.settleConfigurationMaintenance(request)).rejects.toBeInstanceOf(
            Error,
          );
        } finally {
          fault.mockRestore();
          ctx.signal = originalSignal;
        }
        expect(faults).toBeGreaterThan(0);
        const store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
          core = await import("@openmapx/core/build-artifacts"),
          authority = restoreAdmittedControlExecution(installation, prepared.prepare),
          records = await import(
            "../../../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records"
          ),
          owner = records.configurationMaintenanceOwnerRecordSchema.parse(
            JSON.parse(
              readFileSync(
                join(
                  host.infraDir,
                  "state/ops-agent/control/configuration-maintenance",
                  `${prepared.binding.maintenanceId}.json`,
                ),
                "utf8",
              ),
            ),
          ),
          originalFinal = JSON.stringify(owner.final),
          originalInspection = JSON.stringify(owner.inspection),
          [originalSql] =
            await fixture.sql`SELECT state,outcome,settled_at,xmin::text AS xmin FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`;
        expect(owner.receipt.state).toBe("settled");
        expect(owner.apiControls.settle!.result).toBeNull();
        await app.close();
        closeControlInstallation(installation);
        const journal = await openOpsJobJournal(
          join(host.infraDir, "state/ops-agent/jobs-v1.json"),
        );
        installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        const restartedRuntime = await host.reopenRuntime();
        app = buildOpsAgentServer({
          tokens: {
            api: host.token,
            "data-manager": Buffer.alloc(32, 23).toString("base64url"),
          },
          runtime: restartedRuntime,
          resourceClaimer: host.createResourceClaimer(restartedRuntime),
          journal,
          controlInstallation: installation,
        });
        vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
        core.verifyLocalArtifactTargetRootRelease(authority);
        const completedFrom = Date.now(),
          result = await maintenance.settleConfigurationMaintenance(request),
          recovered = store.readOwnedConfigurationMaintenance(
            restoreAdmittedControlExecution(installation, prepared.prepare),
          );
        expect(result).toEqual(owner.receipt);
        expect(recovered.apiControls.settle).toMatchObject({
          operation: request,
          checkedSequence: observed.sequence,
          completedAt: expect.any(Number),
          requestEvidenceDigest: request.evidenceDigest,
          result: { state: "settled" },
        });
        expect(recovered.apiControls.settle!.completedAt).toBeGreaterThanOrEqual(completedFrom);
        expect(JSON.stringify(recovered.final)).toBe(originalFinal);
        expect(JSON.stringify(recovered.inspection)).toBe(originalInspection);
        expect(
          (
            await fixture.sql`SELECT state,outcome,settled_at,xmin::text AS xmin FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`
          )[0],
        ).toEqual(originalSql);
        expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
      });
    }, 60000);
    it.each(["journal"])(
      "settles actual durable nonempty unused maintenance through the original API control and retains its canonical delivery (%s)",
      async () => {
        // This synthetic stack uses local example images and pins no product release.
        vi.stubEnv("OPENMAPX_RELEASE", "local");
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await prospective
              .prepareProspectiveConfiguration({
                actorId: ctx.jobId,
                operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
                expectedCurrentRevisionId: host.initial.revisionId,
                followUp: "service-apply",
                overlay: {
                  purpose: "service-secret",
                  coordinatorMode: "require-running",
                  changes: [
                    {
                      kind: "service-secret",
                      serviceId: "data-manager",
                      key: "TOKEN",
                      action: "set",
                      value: "synthetic-api-unused-final-credential",
                    },
                  ],
                },
              })
              .catch((error: unknown) => {
                if (error instanceof Error && "result" in error) {
                  const result = error.result as { configurationPreflight?: unknown };
                  console.info(
                    JSON.stringify({
                      proof: "unused-maintenance-preflight",
                      configurationPreflight: result.configurationPreflight ?? null,
                    }),
                  );
                }
                throw error;
              }),
            maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
          await maintenance.decideConfigurationMaintenance(decision);
          const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
            ops = await import("@openmapx/core/ops"),
            request = {
              kind: "configurationMaintenance.settle" as const,
              maintenanceId: prepared.binding.maintenanceId,
              candidateId: candidate.candidateId,
              prepareOperationKey: prepared.prepare.operationKey,
              prepareFingerprint: prepared.prepare.operationFingerprint,
              planDigest: prepared.planDigest,
              decisionId: decision.decisionId,
              expectedSequence: observed.sequence,
              evidenceDigest: ops.configurationMaintenanceSettleRequestDigest(observed),
            },
            result = await maintenance.settleConfigurationMaintenance(request),
            authority = restoreAdmittedControlExecution(installation, prepared.prepare),
            store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
            owner = store.readOwnedConfigurationMaintenance(authority);
          expect(result).toMatchObject({
            state: "settled",
            dmFence: { state: "settled" },
            generation: "not_started",
            followUp: "not_started",
          });
          expect(owner.apiControls.settle).toMatchObject({
            operation: request,
            checkedSequence: observed.sequence,
            requestEvidenceDigest: request.evidenceDigest,
            result: { state: "settled" },
          });
          expect(owner.final!.evidenceDigest).not.toBe(request.evidenceDigest);
          const final = JSON.stringify(owner.final),
            inspection = JSON.stringify(owner.inspection),
            [beforeSql] =
              await fixture.sql`SELECT state,outcome,settled_at,xmin::text AS xmin FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`;
          expect(await maintenance.settleConfigurationMaintenance(request)).toEqual(result);
          expect(JSON.stringify(store.readOwnedConfigurationMaintenance(authority).final)).toBe(
            final,
          );
          expect(
            JSON.stringify(store.readOwnedConfigurationMaintenance(authority).inspection),
          ).toBe(inspection);
          expect(
            (
              await fixture.sql`SELECT state,outcome,settled_at,xmin::text AS xmin FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`
            )[0],
          ).toEqual(beforeSql);
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(false);
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          await prospective.discardUnusedPreparedProspectiveConfiguration(candidate);
          expect(
            existsSync(join(host.candidates, `${prepared.binding.applyOperationKey}.json`)),
          ).toBe(false);
          expect(
            (ctx.checkpointResult!._configurationCandidate as Record<string, unknown>).phase,
          ).toBe("discarded");
          await app.close();
          closeControlInstallation(installation);
          const journal = await openOpsJobJournal(
              join(host.infraDir, "state/ops-agent/jobs-v1.json"),
            ),
            original = journal
              .records()
              .find((entry) => entry.operation.kind === "configurationMaintenance.settle")!;
          expect(original).toBeDefined();
          await journal.replace(
            journal.records().filter((entry) => entry.operationKey !== original.operationKey),
          );
          installation = openControlInstallation({
            infraDir: host.infraDir,
            role: "ops-agent",
            serviceIds: host.loaded.map((service) => service.manifest.id),
          });
          const runtime = await host.reopenRuntime();
          app = buildOpsAgentServer({
            tokens: {
              api: host.token,
              "data-manager": Buffer.alloc(32, 23).toString("base64url"),
            },
            runtime,
            resourceClaimer: host.createResourceClaimer(runtime),
            journal,
            controlInstallation: installation,
          });
          vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
          const lookup = await app.inject({
            method: "GET",
            url: `/v1/operation-keys/${original.operationKey}`,
            headers: {
              authorization: `Bearer ${host.token}`,
              "x-ops-request-id": randomUUID(),
              "x-ops-protocol-version": "2",
              "x-ops-body-fingerprint": original.operationFingerprint!,
              "x-ops-operation-fingerprint": original.fingerprint,
            },
          });
          expect(lookup.statusCode).toBe(200);
          expect(lookup.json().result).toMatchObject({
            state: "succeeded",
            operationId: original.operationId,
            result,
            admittedAt: original.admittedAt,
            deadlineAt: original.deadlineAt,
            updatedAt: original.updatedAt,
          });
          expect(
            journal.records().find((entry) => entry.operationKey === original.operationKey),
          ).toEqual(original);
          expect(await maintenance.settleConfigurationMaintenance(request)).toEqual(result);
        });
        const next = await job();
        await owned(next, async () =>
          expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
        );
      },
      60000,
    );
    it.each([false, true])(
      "retains one actual durable nonempty unsaved maintenance abandon decision and rejects an attempted save=%s",
      async (saveAttempted) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: "running",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
              actorId: ctx.jobId,
              operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
              expectedCurrentRevisionId: host.initial.revisionId,
              followUp: "service-apply",
              overlay: {
                purpose: "service-secret",
                coordinatorMode: "ensure-running",
                changes: [
                  {
                    kind: "service-secret",
                    serviceId: "data-manager",
                    key: "TOKEN",
                    action: "set",
                    value: "synthetic-abandon-credential",
                  },
                ],
              },
            }),
            maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            lifecycle = host.calls.filter(
              (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
            ).length;
          if (saveAttempted) {
            // Actual durable DB state disagrees with the stale in-memory checkpoint.
            await fixture.db
              .update(schema.adminJob)
              .set({
                result: {
                  ...ctx.checkpointResult,
                  _configurationCandidate: {
                    ...(ctx.checkpointResult!._configurationCandidate as Record<string, unknown>),
                    phase: "save_attempted",
                  },
                },
              })
              .where(eq(schema.adminJob.id, ctx.jobId));
            await expect(
              maintenance.prepareConfigurationMaintenanceAbandon(candidate),
            ).rejects.toThrow("Original known-unsaved maintenance checkpoint required");
            expect(
              (
                await fixture.db
                  .select()
                  .from(schema.adminJob)
                  .where(eq(schema.adminJob.id, ctx.jobId))
              )[0]?.result,
            ).not.toHaveProperty("_configurationMaintenanceDecision");
          } else {
            const decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
            expect(decision).toMatchObject({
              kind: "configurationMaintenance.decide",
              maintenanceId: prepared.binding.maintenanceId,
              candidateId: candidate.candidateId,
              prepareOperationKey: prepared.prepare.operationKey,
              prepareFingerprint: prepared.prepare.operationFingerprint,
              planDigest: prepared.planDigest,
              decision: "abandon",
              expectedSequence: prepared.sequence,
              checkpointVersion: ctx.execution!.version,
            });
            expect(await maintenance.prepareConfigurationMaintenanceAbandon(candidate)).toEqual(
              decision,
            );
            const [row] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, ctx.jobId));
            expect(row?.result).toMatchObject({
              _configurationMaintenanceDecision: {
                version: 1,
                operation: decision,
                rowVersions: [],
                attempt: "not_attempted",
              },
            });
            expect(JSON.stringify(row?.result)).not.toContain("synthetic-abandon-credential");
            const executionsPath = join(host.infraDir, "state/ops-agent/control/executions"),
              executionsBefore = readdirSync(executionsPath).sort(),
              rootBytes = readFileSync(
                join(executionsPath, `${prepared.prepare.operationKey}.json`),
              ),
              [guardBefore] =
                await fixture.sql`SELECT xmin::text AS version FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`;
            const core = await import("@openmapx/core/build-artifacts"),
              originalAuthority = restoreAdmittedControlExecution(installation, prepared.prepare),
              lease = core.restoreArtifactTargetLeaseForSettlement(originalAuthority),
              ownerRecord = () => JSON.stringify(heldLease(host.infraDir, lease.leaseId)),
              ownerBytes = ownerRecord();
            core.closeArtifactTargetLeaseHandle(lease);
            await expect(
              maintenance.decideConfigurationMaintenance({
                ...decision,
                checkpointDigest: "f".repeat(64),
              }),
            ).rejects.toThrow("Original known-unsaved maintenance checkpoint required");
            const authorized = await maintenance.decideConfigurationMaintenance(decision);
            expect(authorized).toMatchObject({
              state: "authorized",
              sequence: prepared.sequence + 1,
              decision: {
                decisionId: decision.decisionId,
                decision: "abandon",
                checkpointDigest: decision.checkpointDigest,
              },
              dmFence: prepared.dmFence,
              generation: "not_started",
              followUp: "not_started",
            });
            const store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
              authority = restoreAdmittedControlExecution(installation, prepared.prepare),
              original = JSON.stringify(
                store.readOwnedConfigurationMaintenance(authority).apiControls.decide,
              ),
              projection = (await import("../admin-job-ops")).readProjection(
                ctx.protocol,
                ctx.checkpointResult,
              ),
              [control] = Object.values(projection.operations).filter(
                (operation) => operation.kind === "configurationMaintenance.decide",
              );
            expect(control).toMatchObject({
              operation: decision,
              terminal: true,
              receiptDelivery: expect.anything(),
            });
            expect(
              store.readOwnedConfigurationMaintenance(authority).apiControls.decide,
            ).toMatchObject({
              execution: { operationKey: control!.operationKey },
              canonicalDigest: control!.receiptDelivery!.terminalDigest,
            });
            const actualControl =
                store.readOwnedConfigurationMaintenance(authority).apiControls.decide!,
              { verifyApiJobParentExecution } = await import("@openmapx/core/ops"),
              actualParent = verifyApiJobParentExecution(actualControl.parentAssertion, {
                operationKey: actualControl.execution.operationKey,
                operationFingerprint: actualControl.execution.operationFingerprint,
                requestedDeadlineAt: actualControl.requestedDeadlineAt,
              }),
              handle = store.admitConfigurationMaintenanceControlOwner(
                installation,
                decision,
                actualParent,
                {
                  operationKey: actualControl.execution.operationKey,
                  requestedDeadlineAt: actualControl.requestedDeadlineAt,
                },
              ),
              exposed = store.configurationMaintenanceControlOwnerState(
                handle,
                decision,
                actualControl.execution.operationKey,
              ),
              foreignKey = "opk1_foreignControlScope0001";
            expect(Reflect.set(exposed, "requestKey", foreignKey)).toBe(false);
            expect(() =>
              store.configurationMaintenanceControlOwnerState(handle, decision, foreignKey),
            ).toThrow();
            expect(await maintenance.decideConfigurationMaintenance(decision)).toEqual(authorized);
            expect(await maintenance.prepareConfigurationMaintenance(candidate)).toEqual(prepared);
            expect(ctx.checkpointResult?._configurationMaintenance).toMatchObject({
              phase: "authorized",
              decision,
              receipt: authorized,
            });
            expect(
              JSON.stringify(store.readOwnedConfigurationMaintenance(authority).apiControls.decide),
            ).toBe(original);
            expect(readdirSync(executionsPath).sort()).toEqual(executionsBefore);
            expect(
              readFileSync(join(executionsPath, `${prepared.prepare.operationKey}.json`)),
            ).toEqual(rootBytes);
            expect(ownerRecord()).toEqual(ownerBytes);
            const [guardAfter] =
              await fixture.sql`SELECT xmin::text AS version FROM data_manager.configuration_fence WHERE fence_id=${prepared.dmFence!.fenceId}::uuid`;
            expect(guardAfter?.version).toBe(guardBefore?.version);
            // Lose only the secondary jobs journal entry after the actual private
            // original-owner CAS and authenticated API copy/ACK. Reopen the real
            // assembly: lookup must recover that exact immutable source, not admit
            // another request/root or infer success from the API's cached result.
            await app.close();
            closeControlInstallation(installation);
            const journalPath = join(host.infraDir, "state/ops-agent/jobs-v1.json"),
              journal = await openOpsJobJournal(journalPath),
              originalEntry = journal
                .records()
                .find((entry) => entry.operationKey === control!.operationKey)!;
            expect(originalEntry).toBeDefined();
            await journal.replace(
              journal.records().filter((entry) => entry.operationKey !== control!.operationKey),
            );
            installation = openControlInstallation({
              infraDir: host.infraDir,
              role: "ops-agent",
              serviceIds: host.loaded.map((service) => service.manifest.id),
            });
            const restartedRuntime = await host.reopenRuntime();
            app = buildOpsAgentServer({
              tokens: {
                api: host.token,
                "data-manager": Buffer.alloc(32, 23).toString("base64url"),
              },
              runtime: restartedRuntime,
              resourceClaimer: host.createResourceClaimer(restartedRuntime),
              journal,
              controlInstallation: installation,
            });
            vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
            const lookup = await app.inject({
              method: "GET",
              url: `/v1/operation-keys/${control!.operationKey}`,
              headers: {
                authorization: `Bearer ${host.token}`,
                "x-ops-request-id": randomUUID(),
                "x-ops-protocol-version": "2",
                "x-ops-body-fingerprint": originalEntry.operationFingerprint!,
                "x-ops-operation-fingerprint": originalEntry.fingerprint,
              },
            });
            expect(lookup.statusCode).toBe(200);
            expect(lookup.json().result).toMatchObject({
              state: "succeeded",
              operationId: originalEntry.operationId,
              operationKey: originalEntry.operationKey,
              fingerprint: originalEntry.fingerprint,
              result: authorized,
              admittedAt: originalEntry.admittedAt,
              deadlineAt: originalEntry.deadlineAt,
              updatedAt: originalEntry.updatedAt,
            });
            expect(
              journal.records().find((entry) => entry.operationKey === control!.operationKey),
            ).toEqual(originalEntry);
            await app.close();
            const privateOwner = join(
                host.infraDir,
                "state/ops-agent/control/configuration-maintenance",
                `${prepared.binding.maintenanceId}.json`,
              ),
              hiddenOwner = join(host.root, "temporarily-unavailable-maintenance-owner.json");
            nodeFs.renameSync(privateOwner, hiddenOwner);
            try {
              const restartedRuntime = await host.reopenRuntime();
              app = buildOpsAgentServer({
                tokens: {
                  api: host.token,
                  "data-manager": Buffer.alloc(32, 23).toString("base64url"),
                },
                runtime: restartedRuntime,
                resourceClaimer: host.createResourceClaimer(restartedRuntime),
                journal,
                controlInstallation: installation,
              });
              const failure = await app.ready().then(
                () => null,
                (error: Error) => error,
              );
              expect(failure?.message).toBe(
                "Original maintenance control private source unavailable",
              );
            } finally {
              nodeFs.renameSync(hiddenOwner, privateOwner);
            }
            expect(ownerRecord()).toEqual(ownerBytes);
            expect(readdirSync(executionsPath).sort()).toEqual(executionsBefore);
          }
          expect(dm!.preparePosts).toBe(1);
          expect(
            host.calls.filter(
              (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
            ),
          ).toHaveLength(lifecycle);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
        });
      },
      60000,
    );
    it.each([false, true])(
      "starts the actual durable nonempty whole stack with an initially running coordinator=%s without replacing protected services",
      async (running) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const coordinator = {
          ...host.row,
          Id: "c".repeat(64),
          State: running ? "running" : "exited",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        host.setRows([host.row, coordinator]);
        host.setCreatingProcess(async (args) => {
          if (args.includes("up") && args.includes("data-manager")) {
            expect(args).toContain("--no-recreate");
            coordinator.State = "running";
            host.setRows([host.row, coordinator]);
          }
        });
        mkdirSync(join(host.infraDir, "data/source-osm"), { recursive: true });
        writeFileSync(join(host.infraDir, "data/source-osm/fixture.pbf"), "public-whole-stack");
        const { jobRunner } = await import("../job-runner"),
          { createDurableOpsKey } = await import("../ops-client"),
          options = {
            actorId: "loopback-admin",
            operationKey: createDurableOpsKey("task096.whole-stack", randomUUID()),
          };
        const result = await jobRunner.startImmediateCompose(options);
        expect(result).toMatchObject({
          ok: true,
          hardlinks: { applied: true, entries: 1, linked: 1 },
        });
        expect(await jobRunner.startImmediateCompose(options)).toEqual(result);
        const starts = host.calls.filter((args) => args.includes("up"));
        expect(starts.length).toBe(3); // Preparation always uses the original safe --no-recreate DM Start.
        for (const args of starts.filter(
          (args) => args.includes("data-manager") || args.includes("ops-agent"),
        ))
          expect(args).toContain("--no-recreate");
        expect(starts.at(-1)).toContain("--no-deps");
        expect(starts.at(-1)).not.toContain("data-manager");
        expect(starts.at(-1)).not.toContain("ops-agent");
        expect(actualPosts.get("stack.start")).toBe(1);
        const [retained] = await fixture.db.select().from(schema.adminJob);
        expect(retained?.status).toBe("success");
      },
      90000,
    );

    it.each([false, true])(
      "prepares durable nonempty render-only hardlinks with a running coordinator=%s and zero lifecycle",
      async (running) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        host.setRows([
          host.row,
          {
            ...host.row,
            Id: "c".repeat(64),
            State: running ? "running" : "exited",
            ConfigImage: "example/data-manager:1",
            Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
          },
        ]);
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
        const ctx = await renderJob(),
          { handleComposeRenderJob } = await import("../admin-compose-render");
        if (running) {
          const result = await handleComposeRenderJob(ctx);
          expect(result).toMatchObject({
            configuration: { outcome: "committed", followUp: "complete", restartRequired: true },
            hardlinks: { applied: true, entries: 1, linked: 1 },
          });
        } else {
          await expect(handleComposeRenderJob(ctx)).rejects.toThrow();
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
          expect(readdirSync(host.candidates)).toEqual([]);
        }
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
          ),
        ).toBe(false);
      },
    );
    it.each(["stale", "coordinator-stops"] as const)(
      "keeps durable nonempty render-only publication truthful when %s",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const coordinator = {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        host.setRows([host.row, coordinator]);
        mkdirSync(join(host.infraDir, "data/source-osm"), { recursive: true });
        writeFileSync(join(host.infraDir, "data/source-osm/fixture.pbf"), "public-render-race");
        const ctx = await renderJob(
            mode === "stale" ? `cfg1_${"x".repeat(43)}` : host.initial.revisionId,
          ),
          { handleComposeRenderJob } = await import("../admin-compose-render");
        if (mode === "coordinator-stops") {
          const checkpoint = ctx.checkpoint;
          ctx.checkpoint = async (...args) => {
            await checkpoint(...args);
            if (
              (args[0].configuration as { outcome?: string } | undefined)?.outcome === "committed"
            ) {
              coordinator.State = "exited";
              host.setRows([host.row, coordinator]);
              await dm!.stopForRestart();
            }
          };
        }
        await expect(handleComposeRenderJob(ctx)).rejects.toThrow();
        if (mode === "stale")
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
        else {
          expect(services.currentConfigurationGeneration(host.infraDir)).not.toBe(
            host.initial.revisionId,
          );
          expect(ctx.checkpointResult).toMatchObject({ configuration: { outcome: "committed" } });
        }
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
          ),
        ).toBe(false);
      },
      60000,
    );

    it.each([false, true])(
      "applies a durable nonempty generation leaf through API, actual agent and DM, with lost response=%s",
      async (loseResponse) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
          loseHardlinkResponse: loseResponse,
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
        const plan = JSON.parse(
          readFileSync(
            services.currentConfigurationFile(host.infraDir, services.GENERATED_HARDLINK_PLAN_FILE),
            "utf8",
          ),
        );
        expect(plan).toHaveLength(1);
        const ctx = await job(),
          { executeAdminJobOperation } = await import("../admin-job-ops");
        const result = await executeAdminJobOperation(
          ctx,
          {
            kind: "configuration.hardlinks.apply",
            revisionId: host.initial.revisionId,
            coordinatorMode: "require-running",
          },
          "task012.nonempty-hardlinks",
          { durableIdentity: host.initial.revisionId },
        ).catch(async (error) => {
          const operation = Object.values(
            (
              ctx.protocol?.operations as {
                operations: Record<string, { operationKey: string }>;
              }
            ).operations,
          )[0]!;
          const execution = JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "state/ops-agent/control/executions",
                `${operation.operationKey}.json`,
              ),
              "utf8",
            ),
          ).execution;
          const authority = restoreAdmittedControlExecution(installation, execution),
            bound = lookupControlChildPhaseBinding(authority, { phase: "hardlinks", ordinal: 0 });
          let witness: unknown = "no-binding";
          if (bound) {
            const child = await dm!.store.lookup(bound.child.execution.operationKey);
            try {
              assertDataManagerTerminal(bound.child.execution, child!.status);
              witness = "verified";
            } catch (failure) {
              witness = String(failure);
            }
          }
          const attempt = lookupControlChildPhaseAttempt(authority, {
            phase: "hardlinks",
            ordinal: 0,
          });
          const held = attempt?.leaseId ? heldLease(host.infraDir, attempt.leaseId) : undefined;
          throw Error(
            `${String(error)}; witness=${String(witness)}; lease=${JSON.stringify(held)}; DM replies: ${JSON.stringify(await dm?.diagnostics())}`,
          );
        });
        expect(result).toMatchObject({ applied: true, entries: 1, linked: 1, via: "data-manager" });
        expect(dm.posts).toBe(1);
        const destination = join(host.infraDir, plan[0].target, "fixture.pbf");
        expect(statSync(destination).ino).toBe(statSync(join(source, "fixture.pbf")).ino);
        expect(host.calls.some((args) => args.includes("up") || args.includes("restart"))).toBe(
          false,
        );
        expect(heldTargets(host.infraDir).includes("motis")).toBe(false);
      },
      60000,
    );
    it.each(["ensure-running", "require-running"] as const)(
      "retains committed desired state when the durable nonempty coordinator stops after generation commit (mode=%s)",
      async (coordinatorMode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(dm.token));
        const dmRow = {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        host.setRows([host.row, dmRow]);
        const source = join(host.infraDir, "data/source-osm");
        mkdirSync(source, { recursive: true });
        writeFileSync(join(source, "fixture.pbf"), "public-stopped-coordinator");
        const ctx = await job();
        let stopped = false,
          stoppedCallIndex = 0;
        await owned(ctx, async () => {
          const candidate = await prospective.prepareProspectiveConfiguration({
            actorId: ctx.jobId,
            operationKey: `opk1_${ctx.jobId.replaceAll("-", "")}`,
            expectedCurrentRevisionId: host.initial.revisionId,
            followUp: "service-apply",
            overlay: {
              purpose: "service-secret",
              coordinatorMode,
              changes: [
                {
                  kind: "service-secret",
                  serviceId: "data-manager",
                  key: "TOKEN",
                  action: "set",
                  value: "synthetic-postcommit-coordinator-stop",
                },
              ],
            },
          });
          const stopAfterCommit = async () => {
            if (services.currentConfigurationGeneration(host.infraDir) === candidate.revisionId) {
              stopped = true;
              stoppedCallIndex = host.calls.length;
              dmRow.State = "exited";
              host.setRows([host.row, dmRow]);
            } else host.setInventoryProcess(stopAfterCommit);
          };
          host.setInventoryProcess(stopAfterCommit);
          let failure: unknown;
          try {
            await prospective.persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode,
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeDefined();
          expect(stopped).toBe(true);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(candidate.revisionId);
          expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
          expect(ctx.checkpointResult!._configurationMaintenanceDecision).toMatchObject({
            operation: { decision: "continue" },
            attempt: "attempted",
          });
          expect(ctx.checkpointResult!._configurationCandidate).toMatchObject({
            candidateId: candidate.candidateId,
            phase: "saved",
          });
          expect(
            host.calls
              .slice(stoppedCallIndex)
              .some(
                (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
              ),
          ).toBe(false);
          expect(actualPosts.get("service.start") ?? 0).toBe(
            coordinatorMode === "ensure-running" ? 1 : 0,
          );
          expect(dm!.settlePosts).toBe(0);
          expect(
            existsSync(
              join(
                host.candidates,
                `${prospective.validatedConfigurationCandidateState(candidate).record.operationKey}.json`,
              ),
            ),
          ).toBe(true);
          expect(heldTargets(host.infraDir).includes("data-manager")).toBe(true);
        });
        const next = await job();
        await expect(owned(next, async () => undefined)).rejects.toThrow(
          "Configuration writer unavailable",
        );
        console.info(
          JSON.stringify({
            proof: "postcommit-coordinator-stop-no-fallback",
            coordinatorMode,
            desiredRows: 1,
            postcommitStarts: 0,
            rootFenced: true,
            nextWriterRefused: true,
          }),
        );
      },
      120000,
    );
    it.each(["pull", "recreate", "cancel", "crash-pull", "crash-recreate", "missing-receipt"])(
      "retains the actual default CLI Update failure and borrowed-child containment (mode=%s)",
      async (mode) => {
        const bin = join(host.root, "fixture-bin"),
          trace = join(host.root, "docker-argv.jsonl"),
          marker = join(host.root, "pull-started"),
          receiptDirectory = join(host.infraDir, "state/ops-agent/lifecycle"),
          recreated = ["recreate", "crash-recreate", "missing-receipt"].includes(mode),
          crash =
            "fs.writeFileSync(" +
            JSON.stringify(join(host.root, "cli-killed")) +
            ',String(process.ppid));process.kill(process.ppid,"SIGKILL");process.exit(0);';
        mkdirSync(bin);
        writeFileSync(
          join(bin, "docker"),
          `#!${process.execPath}\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+"\\n");
if(args[0]==="compose"&&args.includes("config")&&args.includes("--format")){import(${JSON.stringify(composeFixture)}).then(({readProductionFixtureCompose})=>process.stdout.write(JSON.stringify(readProductionFixtureCompose(args)))).catch(()=>{process.exitCode=1;});}
if(args.includes("pull")){fs.writeFileSync(${JSON.stringify(marker)},String(process.pid));${mode === "cancel" ? "setInterval(()=>{},1000);" : mode === "pull" ? "process.exit(7);" : mode === "crash-pull" ? crash : ""}}
if(args.includes("--force-recreate")){${mode === "recreate" ? "process.exit(9);" : mode === "crash-recreate" ? crash : mode === "missing-receipt" ? `const directory=${JSON.stringify(receiptDirectory)},names=fs.readdirSync(directory).filter(n=>/^opk1_[A-Za-z0-9_-]+\\.json$/.test(n));if(names.length!==1)throw Error("Expected sole owned lifecycle receipt");fs.unlinkSync(require("node:path").join(directory,names[0]));` : ""}}\n`,
          { mode: 0o700 },
        );
        for (const [key, value] of Object.entries({
          PATH: `${bin}:${process.env.PATH}`,
          OPENMAPX_ROOT_DIR: host.root,
          OPENMAPX_RELEASE: "local",
          DOMAIN: "example.test",
          POSTGRES_PASSWORD: "p".repeat(24),
          BETTER_AUTH_SECRET: "a".repeat(32),
          OPENMAPX_ENABLED_SERVICES: "",
        }))
          vi.stubEnv(key, value);
        const ctx = await job(),
          { executeAdminJobOperation, readProjection } = await import("../admin-job-ops"),
          { createApiOpsClient } = await import("../ops-client");
        let failure: unknown;
        ctx.signal = AbortSignal.timeout(45000);
        const running = executeAdminJobOperation(
          ctx,
          {
            kind: "service.update",
            serviceId: "motis",
            expectedConfigurationRevisionId: host.initial.revisionId,
          },
          "task012.default-cli-failure",
          { durableIdentity: "motis" },
        ).catch((error) => {
          failure = error;
        });
        if (mode === "cancel") {
          const until = Date.now() + 30000;
          while (!existsSync(marker)) {
            if (Date.now() > until) throw Error("Actual fixed CLI pull not reached");
            await nativeDelay(20);
          }
          const entry = Object.values(
            readProjection(ctx.protocol, ctx.checkpointResult).operations,
          )[0];
          expect(entry?.operationId).toBeTypeOf("string");
          await createApiOpsClient().cancel(entry!.operationId!, {
            signal: AbortSignal.timeout(15000),
          });
        }
        await running;
        expect(failure).toBeDefined();
        const [entry] = Object.values(
            readProjection(ctx.protocol, ctx.checkpointResult).operations,
          ),
          core = await import("@openmapx/core/build-artifacts"),
          root = restoreAdmittedControlExecution(installation, {
            executor: "ops-agent",
            principal: "api",
            executionId: entry!.operationId!,
            operationKey: entry!.operationKey,
            operationFingerprint: (await import("@openmapx/core/ops")).opsOperationFingerprint(
              entry!.operation!,
            ),
            fingerprint: entry!.fingerprint!,
            deadlineAt: entry!.deadlineAt!,
          }),
          child = lookupControlChildPhaseBinding(root, { phase: "lifecycle", ordinal: 0 });
        expect(child).toBeDefined();
        const receiptRead = services.readServiceLifecycleReceipt({
          dataRoot: join(host.infraDir, "data"),
          execution: child!.child.execution,
        });
        const calls = readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        expect(calls.filter((args) => args.includes("pull"))).toHaveLength(1);
        expect(calls.filter((args) => args.includes("up"))).toHaveLength(recreated ? 1 : 0);
        expect(heldTargets(host.infraDir).includes("motis")).toBe(true);
        expect(() => core.verifyLocalArtifactTargetRootRelease(root)).toThrow();
        if (mode === "missing-receipt") {
          await expect(receiptRead).rejects.toThrow();
          expect(readdirSync(receiptDirectory)).toEqual([]);
          expect(failure).toMatchObject({ name: "OpsObservationPending" });
          const observed = await createApiOpsClient().status(
            "service.update",
            entry!.operationId!,
            {
              signal: AbortSignal.timeout(15000),
            },
          );
          expect(["running", "termination_pending", "failed"]).toContain(observed.state);
          expect(observed.result).toBeUndefined();
          expect(JSON.stringify(observed.diagnostics ?? {})).not.toContain(host.root);
          expect(JSON.stringify(observed.diagnostics ?? {})).not.toContain("/.vol/");
          expect(services.currentConfigurationGeneration(host.infraDir)).not.toBe(
            host.initial.revisionId,
          );
          console.info(
            JSON.stringify({
              proof: "actual-default-cli-missing-receipt",
              authenticatedResult: "unknown",
              noPointerSubstitution: true,
              rootFenced: true,
            }),
          );
          return;
        }
        const receipt = await receiptRead;
        expect(
          receipt.phase === "failed" ||
            receipt.phase === "unknown" ||
            (["cancel", "crash-pull"].includes(mode) && receipt.phase === "pins_validated") ||
            (mode === "crash-recreate" && receipt.phase === "hardlinks_applied"),
        ).toBe(true);
        expect(receipt.seedRevisionId).toBe(host.initial.revisionId);
        expect(receipt.commit).toBe(recreated ? "final_committed" : "seed_committed");
        expect(receipt.followUp).not.toBe("complete");
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          recreated ? receipt.finalRevisionId : host.initial.revisionId,
        );
        if (mode === "cancel") {
          const pid = Number(readFileSync(marker, "utf8"));
          await expect
            .poll(() => {
              try {
                process.kill(pid, 0);
                return true;
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
                throw error;
              }
            })
            .toBe(false);
        }
        if (mode.startsWith("crash-")) {
          const pid = Number(readFileSync(join(host.root, "cli-killed"), "utf8"));
          expect(() => process.kill(pid, 0)).toThrow();
          expect(receipt.finalRevisionId === null).toBe(mode === "crash-pull");
        }
        console.info(
          JSON.stringify({
            proof: "actual-default-cli-failure-contained",
            mode,
            commit: receipt.commit,
            phase: receipt.phase,
            rootFenced: true,
          }),
        );
      },
      90000,
    );
    it.each([false, true])(
      "returns the actual default CLI Update's signed final revision with competing generation=%s",
      async (competing) => {
        const { chmodSync } = await import("node:fs");
        const bin = join(host.root, "fixture-bin"),
          trace = join(host.root, "docker-argv.jsonl");
        mkdirSync(bin);
        // The only child replacement is external Docker I/O. The default runner,
        // installed tsx, real CLI entry, manifests, writer, pins, lease and receipt run.
        const docker = join(bin, "docker");
        writeFileSync(
          docker,
          `#!${process.execPath}\nconst args=process.argv.slice(2);require("node:fs").appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+"\\n");
if(args[0]==="compose"&&args.includes("config")&&args.includes("--format")){import(${JSON.stringify(composeFixture)}).then(({readProductionFixtureCompose})=>process.stdout.write(JSON.stringify(readProductionFixtureCompose(args)))).catch(()=>{process.exitCode=1;});}\n`,
          { mode: 0o700 },
        );
        chmodSync(docker, 0o700);
        for (const [key, value] of Object.entries({
          PATH: `${bin}:${process.env.PATH}`,
          OPENMAPX_ROOT_DIR: host.root,
          OPENMAPX_RELEASE: "local",
          DOMAIN: "example.test",
          POSTGRES_PASSWORD: "p".repeat(24),
          BETTER_AUTH_SECRET: "a".repeat(32),
          OPENMAPX_ENABLED_SERVICES: "",
        }))
          vi.stubEnv(key, value);
        const ctx = await job(),
          { executeAdminJobOperation } = await import("../admin-job-ops");
        const result = await executeAdminJobOperation(
          ctx,
          {
            kind: "service.update",
            serviceId: "motis",
            expectedConfigurationRevisionId: host.initial.revisionId,
          },
          "task012.default-cli-update",
          { durableIdentity: "motis" },
        );
        expect(result.changed).toBe(true);
        if (competing) {
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.competingRevisionId,
          );
          expect(result.revisionId).not.toBe(host.competingRevisionId);
          const { updatePreparedService } = await import("../service-preparation");
          await expect(
            updatePreparedService(ctx, "motis", result.revisionId),
          ).rejects.toMatchObject({
            result: { serviceLifecycle: { failure: { reason: "revision_conflict" } } },
          });
        } else
          expect(result.revisionId).toBe(services.currentConfigurationGeneration(host.infraDir));
        expect(result.revisionId).not.toBe(host.initial.revisionId);
        const calls = readFileSync(trace, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as string[]);
        const lifecycleCalls = calls.filter((args) => args[0] !== "ps" && !args.includes("config"));
        expect(lifecycleCalls).toHaveLength(2);
        expect(lifecycleCalls[0]?.slice(-2)).toEqual(["pull", "motis"]);
        expect(lifecycleCalls[1]?.slice(-4)).toEqual(["up", "-d", "--force-recreate", "motis"]);
        if (!competing) {
          const directory = join(host.infraDir, "state/ops-agent/lifecycle"),
            [name] = readdirSync(directory);
          expect(name).toBeDefined();
          const later = Date.now() + 30 * 24 * 3600000,
            clock = vi.spyOn(Date, "now").mockReturnValue(later);
          try {
            expect(await pruneControlRecords(installation, { now: later })).not.toEqual([]);
            expect(existsSync(join(directory, name!))).toBe(false);
          } finally {
            clock.mockRestore();
          }
        }
      },
      60000,
    );
    it("returns the actual default CLI Update's signed final revision through durable nonempty links", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("OPENMAPX_TEST_FIXED_DM_TARGET", dm.baseUrl);
      vi.stubEnv(
        "NODE_OPTIONS",
        `${process.env.NODE_OPTIONS ?? ""} --import=${new URL("../../../../ops-agent/src/test-fixtures/fixed-cli-data-manager-preload.mjs", import.meta.url).href}`.trim(),
      );
      host.setRows([
        host.row,
        {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        },
      ]);
      const source = join(host.infraDir, "data/source-osm");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "fixture.pbf"), "actual-default-cli-osm");
      const bin = join(host.root, "fixture-bin"),
        trace = join(host.root, "docker-argv.jsonl");
      mkdirSync(bin);
      // Only external Docker I/O is replaced. The actual default runner launches
      // the installed CLI entry, real shared writer, signed receipt and DM leaf.
      writeFileSync(
        join(bin, "docker"),
        `#!${process.execPath}\nconst args=process.argv.slice(2);require("node:fs").appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+"\\n");
if(args[0]==="compose"&&args.includes("config")&&args.includes("--format")){import(${JSON.stringify(composeFixture)}).then(({readProductionFixtureCompose})=>process.stdout.write(JSON.stringify(readProductionFixtureCompose(args)))).catch(()=>{process.exitCode=1;});}\n`,
        { mode: 0o700 },
      );
      for (const [key, value] of Object.entries({
        PATH: `${bin}:${process.env.PATH}`,
        OPENMAPX_ROOT_DIR: host.root,
        OPENMAPX_RELEASE: "local",
        DOMAIN: "example.test",
        POSTGRES_PASSWORD: "p".repeat(24),
        BETTER_AUTH_SECRET: "a".repeat(32),
        DATA_MANAGER_TOKEN_FILE: dataManagerTokenFile(dm.token),
        OPENMAPX_ENABLED_SERVICES: "",
      }))
        vi.stubEnv(key, value);
      const ctx = await job(),
        { executeAdminJobOperation, readProjection } = await import("../admin-job-ops"),
        result = await executeAdminJobOperation(
          ctx,
          {
            kind: "service.update",
            serviceId: "motis",
            expectedConfigurationRevisionId: host.initial.revisionId,
          },
          "task012.default-cli-nonempty-update",
          { durableIdentity: "motis" },
        );
      expect(result).toMatchObject({
        changed: true,
        revisionId: services.currentConfigurationGeneration(host.infraDir),
      });
      expect(result.revisionId).not.toBe(host.initial.revisionId);
      const calls = readFileSync(trace, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as string[]);
      const lifecycleCalls = calls.filter((args) => args[0] !== "ps" && !args.includes("config"));
      expect(lifecycleCalls).toHaveLength(2);
      expect(lifecycleCalls[0]?.slice(-2)).toEqual(["pull", "motis"]);
      expect(lifecycleCalls[1]?.slice(-4)).toEqual(["up", "-d", "--force-recreate", "motis"]);
      expect(dm.posts).toBe(1);
      const [entry] = Object.values(readProjection(ctx.protocol, ctx.checkpointResult).operations),
        root = restoreAdmittedControlExecution(installation, {
          executor: "ops-agent",
          principal: "api",
          executionId: entry!.operationId!,
          operationKey: entry!.operationKey,
          operationFingerprint: (await import("@openmapx/core/ops")).opsOperationFingerprint(
            entry!.operation!,
          ),
          fingerprint: entry!.fingerprint!,
          deadlineAt: entry!.deadlineAt!,
        }),
        child = lookupControlChildPhaseBinding(root, { phase: "lifecycle", ordinal: 0 });
      expect(child).toBeDefined();
      const receipt = await services.readServiceLifecycleReceipt({
        dataRoot: join(host.infraDir, "data"),
        execution: child!.child.execution,
      });
      expect(receipt).toMatchObject({
        phase: "complete",
        finalRevisionId: result.revisionId,
        followUp: "complete",
        commit: "final_committed",
        hardlinks: { entries: 1, linked: 1, via: "data-manager" },
      });
      const plan = JSON.parse(
          readFileSync(
            services.currentConfigurationFile(host.infraDir, services.GENERATED_HARDLINK_PLAN_FILE),
            "utf8",
          ),
        ) as { target: string }[],
        destination = join(host.infraDir, plan[0]!.target, "fixture.pbf");
      expect(statSync(destination).ino).toBe(statSync(join(source, "fixture.pbf")).ino);
      expect(
        JSON.parse(
          readFileSync(
            services.currentConfigurationFile(host.infraDir, services.SERVICE_SELECTION_FILE),
            "utf8",
          ),
        ).selected,
      ).toEqual(["data-manager", "motis"]);
      expect(existsSync(join(host.infraDir, services.CONFIGURATION_DIRECTORY, "writer.lock"))).toBe(
        false,
      );
      expect(heldTargets(host.infraDir)).toEqual([]);
    }, 60000);
  },
);
