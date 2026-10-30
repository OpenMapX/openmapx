import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as nodeFs from "node:fs";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  watch,
  writeFileSync,
} from "node:fs";
import * as nodeFsPromises from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { basename, join } from "node:path";
import { setTimeout as nativeDelay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import {
  closeControlInstallation,
  lookupControlChildPhaseAttempt,
  lookupControlChildPhaseBinding,
  openControlInstallation,
  reconcileControlRetention,
  restoreAdmittedControlExecution,
  verifyDataControlTerminalWitness,
} from "@openmapx/core/build-artifacts";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";
import type { JobContext } from "../job-runner";
import { postgresCommitRelay } from "./fixtures/postgres-commit-relay";

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
    let fixture: Fixture;
    let host: Awaited<ReturnType<typeof ownedServiceHost>>;
    let app: ReturnType<typeof buildOpsAgentServer>;
    let installation: ReturnType<typeof openControlInstallation>;
    let dm: Awaited<ReturnType<typeof ownedDataManager>> | undefined;
    let actualPosts: Map<string, number>;
    beforeEach(async (context) => {
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
      if (context.task.name.includes("future private mount inspection"))
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
      const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
      app = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
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
        OPS_TRUSTED_CONFIG_DIR: host.queue,
        OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
        OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
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
        status: "running",
        result: { _execution: execution },
      });
      const ctx: JobContext = {
        jobId,
        jobType: "service.apply",
        execution,
        payload: {},
        signal: new AbortController().signal,
        checkpointResult: { _execution: execution },
        log: async () => {},
        setProgress: async () => {},
        checkpoint: async (result, progress, admissionKey, stepAddress) => {
          if ((result.opsProjection as { version?: number } | undefined)?.version === 3)
            ctx.checkpointResult = await checkpointOwnedAdminJob(
              jobId,
              execution,
              result,
              progress,
              admissionKey,
              stepAddress,
              ctx.checkpointResult ?? {},
            );
          else {
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
    it.each([
      "saved",
      "applied",
      "missing",
      "corrupt",
      "hardlink",
      "credential-saved",
      "credential-recreated",
    ])(
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
            Object.values(rows[0]!.result?.opsProjection?.operations ?? {}).some((value) => {
              const operation = value as {
                kind?: string;
                terminal?: boolean;
                receiptDelivery?: { state?: string };
              };
              return (
                operation.kind === (afterRecreate ? "service.recreate" : applyKind) &&
                operation.terminal === true &&
                operation.receiptDelivery?.state === "pending"
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
                BETTER_AUTH_SECRET: "synthetic-task012-native-api-auth-fixture",
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
        let readyObserver: ReturnType<typeof watch> | undefined;
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
            path = join(host.queue, ".candidates", `${candidate.sealedOperationKey}.json`),
            bytes = readFileSync(path),
            record = JSON.parse(bytes.toString()).record,
            parent = {
              operationKey: record.parentOperationKey,
              fingerprint: record.parentFingerprint,
              deadlineAt: record.parentDeadlineAt,
            },
            versions = await readVersions();
          const refused = ["missing", "corrupt", "hardlink"].includes(mode);
          expect(versions).toHaveLength(1);
          expect(candidate.phase).toBe(afterRecreate ? "follow_up_pending" : "saved");
          expect(actualPosts.get(applyKind) ?? 0).toBe(mode === "applied" || afterRecreate ? 1 : 0);
          first.child.kill("SIGKILL");
          expect((await first.exited).signal).toBe("SIGKILL");
          relay.release();
          if (mode === "missing") rmSync(path);
          if (mode === "corrupt") {
            const value = JSON.parse(bytes.toString());
            value.mac = value.mac === "A".repeat(43) ? "B".repeat(43) : "A".repeat(43);
            writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
          }
          if (mode === "hardlink") linkSync(path, join(host.root, "candidate-alias"));
          const [retained] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id)),
            lease = Date.parse(
              (retained!.result as Record<string, unknown>)._observationLeaseUntil as string,
            );
          expect(Number.isFinite(lease)).toBe(true);
          while (Date.now() <= lease + 100)
            await nativeDelay(Math.min(1000, lease + 101 - Date.now()));
          if (!refused) expect(readFileSync(path).equals(bytes)).toBe(true);
          let readyPublications = 0;
          if (mode === "applied") {
            expect(existsSync(join(host.queue, `${candidate.revisionId}.json`))).toBe(false);
            readyObserver = watch(host.queue, (_event, name) => {
              if (
                name?.toString() === `${candidate.revisionId}.json` &&
                existsSync(join(host.queue, name.toString()))
              )
                readyPublications++;
            });
          }
          expect((await start().exited).code).toBe(refused ? 2 : 0);
          const [finished] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id)),
            result = finished!.result as Record<string, unknown>;
          expect(finished!.status).toBe(refused ? "running" : "success");
          expect((result._execution as { version: number }).version).toBe(2);
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
          expect(readyPublications).toBe(0);
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
          readyObserver?.close();
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
      "after-ack-loss",
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
            beforeSave ||
            mode === "after-settle" ||
            mode === "after-ack-loss" ||
            preRootHelper ||
            unusedAfterSettle,
          preparePosts = 0,
          settlePosts = 0,
          originalPrepareKey: string | undefined,
          ackInterrupted = false;
        const { AnchoredDirectory } = await import(
            "../../../../../packages/core/src/build-artifacts/filesystem"
          ),
          writeCell = AnchoredDirectory.prototype.write,
          ackFault =
            mode === "after-ack-loss"
              ? vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
                  this: InstanceType<typeof AnchoredDirectory>,
                  name,
                  bytes,
                  ...args
                ) {
                  if (
                    !ackInterrupted &&
                    originalPrepareKey &&
                    name === `${originalPrepareKey}.configuration-settlement-ack.json` &&
                    Buffer.byteLength(bytes) === 1024 &&
                    typeof JSON.parse(String(bytes))?.payload?.terminalDigest === "string"
                  ) {
                    ackInterrupted = true;
                    throw Error("Synthetic original native sender ACK filesystem interruption");
                  }
                  return writeCell.call(this, name, bytes, ...args);
                })
              : undefined;
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
              originalPrepareKey = JSON.parse(body.toString()).operationKey;
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
                await fixture.sql`SELECT result FROM admin_job WHERE payload->>'operationKey'=${key}`;
              if (
                original?.result?._configurationCandidate?.phase === "prepared" &&
                !Object.values(original.result?.opsProjection?.operations ?? {}).some(
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
                : mode === "after-ack-loss"
                  ? parsed.result?.kind === "configurationMaintenance.settle" &&
                    parsed.result?.state === "failed"
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
                    return (
                      c?.phase === "settled" &&
                      (retired
                        ? !existsSync(
                            join(host.queue, ".candidates", `${c.sealedOperationKey}.json`),
                          )
                        : c.retirement?.version === 1 &&
                          existsSync(
                            join(host.queue, ".candidates", `${c.sealedOperationKey}.json`),
                          ))
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
                "com.docker.compose.project.working_dir": join(
                  host.infraDir,
                  ".trusted-config-generations",
                  nativeRevision,
                ),
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
                BETTER_AUTH_SECRET: "synthetic-task012-native-api-auth-fixture",
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
              const projection = (await import("../admin-job-projection")).readProjection(result);
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
            mode === "after-settle" || mode === "after-ack-loss" || retirement || unusedAfterSettle
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
          const candidatePath = join(
              host.queue,
              ".candidates",
              `${candidate.sealedOperationKey}.json`,
            ),
            candidateBytes = retired ? undefined : readFileSync(candidatePath),
            rootLock = join(host.infraDir, "data/.admin-target-control/locks/data-manager"),
            rootInode = existsSync(rootLock) ? statSync(rootLock).ino : null;
          expect(rootInode === null).toBe(
            mode === "after-settle" ||
              preRootHelper ||
              refusedPreparation ||
              retirement ||
              unusedAfterSettle,
          );
          const refusedOwnerPath = join(
              host.infraDir,
              "control-private/ops-agent/configuration-maintenance",
              `${candidate.maintenanceId}.json`,
            ),
            refusedOwnerBytes = refusedPreparation ? readFileSync(refusedOwnerPath) : undefined;
          const helper = preRootHelper
              ? JSON.parse(candidateBytes!.toString()).record.coordinatorPrerequisite
              : null,
            helperAdmission =
              helper && !unattemptedHelper
                ? readFileSync(
                    join(
                      host.infraDir,
                      "control-private/ops-agent/executions",
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
                    "control-private/ops-agent/executions",
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
          first.child.kill("SIGKILL");
          expect((await first.exited).signal).toBe("SIGKILL");
          if (mode.endsWith("-cancel-daemon")) {
            await (await import("../job-runner")).jobRunner.cancel(original!.id);
            const [canceled] = await fixture.db
              .select()
              .from(schema.adminJob)
              .where(eq(schema.adminJob.id, original!.id));
            expect(canceled!.status).toBe("cancel_pending");
            expect((canceled!.result as Record<string, unknown>)._cancelRequestedAt).toBeTypeOf(
              "string",
            );
          }
          if (mode === "after-ack-loss") expect(ackInterrupted).toBe(true);
          ackFault?.mockRestore();
          holdPreparedReply = false;
          releaseReply.resolve();
          sqlRelay?.release();
          const [retained] = await fixture.db
            .select()
            .from(schema.adminJob)
            .where(eq(schema.adminJob.id, original!.id));
          const lease = Date.parse(
            (retained!.result as Record<string, unknown>)._observationLeaseUntil as string,
          );
          expect(Number.isFinite(lease)).toBe(true);
          while (Date.now() <= lease + 100)
            await nativeDelay(Math.min(1000, lease + 101 - Date.now()));
          expect(
            retired
              ? !existsSync(candidatePath)
              : readFileSync(candidatePath).equals(candidateBytes!),
          ).toBe(true);
          expect(existsSync(rootLock) ? statSync(rootLock).ino : null).toBe(rootInode);
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
            result = finished!.result as Record<string, unknown>;
          if (refusedPreparation) {
            expect(finished!.status).toBe("failed");
            expect(result._execution).toMatchObject({ version: 2 });
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
              owner = core.verifyControl(
                installation.publicKey,
                "openmapx-configuration-maintenance-owner-v2",
                JSON.parse(refusedOwnerBytes!.toString()),
                records.configurationMaintenanceOwnerRecordSchema,
              ),
              authority = restoreAdmittedControlExecution(installation, owner.plan.prepare);
            core.assertConfigurationMaintenanceRootClosure(authority);
            core.verifyRetainedArtifactTargetRootRelease(authority);
            expect(existsSync(candidatePath)).toBe(false);
            expect(existsSync(rootLock)).toBe(false);
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
            expect(result._execution).toMatchObject({ version: 2 });
            expect(result._parentExecution).toEqual(parent);
            expect(result._cancelRequestedAt).toBeTypeOf("string");
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
            expect(existsSync(rootLock)).toBe(false);
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
            core.verifyRetainedArtifactTargetRootRelease(
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
            expect(result._execution).toMatchObject({ version: 2 });
            expect(result._parentExecution).toEqual(parent);
            expect(result._cancelRequestedAt).toBeTypeOf("string");
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
                    "control-private/ops-agent/executions",
                    `${helper.root.operationKey}.json`,
                  ),
                ).equals(helperAdmission!),
              ).toBe(true);
            expect(existsSync(candidatePath)).toBe(false);
            expect(existsSync(rootLock)).toBe(false);
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
            expect(result._execution).toMatchObject({ version: 2 });
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
                  "control-private/ops-agent/executions",
                  `${helper.root.operationKey}.json`,
                ),
              ).equals(helperAdmission!),
            ).toBe(true);
            expect(existsSync(candidatePath)).toBe(false);
            expect(existsSync(rootLock)).toBe(false);
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
            expect(result._execution).toMatchObject({ version: 2 });
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
            expect(statSync(rootLock).ino).toBe(rootInode);
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
          expect((result._execution as { version: number }).version).toBe(2);
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
            expect(finalOwner.rootCertificateDigest).toBe(originalOwner.rootCertificateDigest);
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
            const retainedRecord = JSON.parse(candidateBytes!.toString()).record
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
          expect(
            existsSync(join(host.queue, ".candidates", `${candidate.sealedOperationKey}.json`)),
          ).toBe(false);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(false);
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
                    "control-private/ops-agent/executions",
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
                  JSON.parse(candidateBytes!.toString()).record,
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
          ackFault?.mockRestore();
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
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(1);
        expect(readdirSync(host.queue).filter((name) => /^cfg1_/.test(name))).toHaveLength(0);
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
        const { publishPreparedTrustedConfigurationSnapshot } = await import(
          "../trusted-config-publisher"
        );
        // Diagnostic state is not commit authority, even for an internal caller.
        prospective.validatedConfigurationCandidateState(candidate).persisted = true;
        await expect(publishPreparedTrustedConfigurationSnapshot(candidate)).rejects.toThrow();
        expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
        expect(readdirSync(host.queue).filter((name) => name.startsWith("cfg1_"))).toEqual([]);
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
      expect(readdirSync(host.queue).filter((name) => /^cfg1_/.test(name))).toHaveLength(0);
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
        expect(candidate.sealedBytes).toBeLessThanOrEqual(524288);
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
      expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
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
      const before = readdirSync(join(host.infraDir, ".trusted-config-generations")).length;
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
      expect(readdirSync(join(host.infraDir, ".trusted-config-generations"))).toHaveLength(
        before + 1,
      );
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        const pointer = join(host.infraDir, ".trusted-config-current"),
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
          const candidates = join(host.queue, ".candidates");
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
    it("refuses an actual durable nonempty candidate whose future private mount inspection exceeds capacity before any root or DM guard", async () => {
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                value: "synthetic-prospective-capacity-credential",
              },
            ],
          },
        });
        expect(candidate.sealedBytes).toBeLessThan(524288);
        const maintenance = await import("../configuration-maintenance");
        await expect(maintenance.prepareConfigurationMaintenance(candidate)).rejects.toBeInstanceOf(
          Error,
        );
        expect(dm!.preparePosts).toBe(0);
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
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
      // Synthetic example/* images intentionally have no published release overlay.
      vi.stubEnv("OPENMAPX_RELEASE", "local");
      vi.stubEnv("DOMAIN", "example.test");
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          row = {
            ...dmRow,
            Id: "d".repeat(64),
            Labels: {
              ...dmRow.Labels,
              "com.docker.compose.project.working_dir": join(
                host.infraDir,
                ".trusted-config-generations",
                revision,
              ),
              "com.docker.compose.project.config_files":
                services.configurationGenerationComposeFile(host.infraDir, revision),
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          await fixture.sql`SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance'`,
        ).toEqual([]);
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(1);
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
        const projection = ctx.checkpointResult!.opsProjection as {
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
        expect(starts[0]!.receiptDelivery).toMatchObject({ state: "confirmed" });
        const source = verifyMaintenanceCoordinatorPrerequisite(installation, record);
        expect(source.execution.operationKey).toBe(
          record.coordinatorPrerequisite!.root.operationKey,
        );
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
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(
          await fixture.sql`SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance'`,
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
        const helperPath = join(
            host.infraDir,
            "control-private/ops-agent/executions",
            `${state.record.coordinatorPrerequisite!.root.operationKey}.json`,
          ),
          admission = readFileSync(helperPath);
        while (Date.now() <= state.record.parentDeadlineAt)
          await nativeDelay(Math.min(1000, state.record.parentDeadlineAt - Date.now() + 10));
        expect(JSON.parse(state.sealed.bytes.toString()).expiresAt > new Date().toISOString()).toBe(
          true,
        );
        await expect(
          prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "ensure-running",
          }),
        ).rejects.toThrow("Configuration candidate expired");
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
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          path = join(host.queue, ".candidates", `${state.record.operationKey}.json`),
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        // An independent actual connection races the complete original source
        // after the genuine old-revision Start, before maintenance admission.
        await fixture.db
          .insert(schema.serviceConfig)
          .values({ id: randomUUID(), serviceId: "motis", config: { WORKERS: 7 } });
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
        await expect(
          prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "ensure-running",
          }),
        ).rejects.toThrow("Configuration source conflict");
        expect(starts).toBe(1);
        expect(dm!.preparePosts).toBe(0);
        expect(dm!.settlePosts).toBe(0);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
        expect(coordinator.State).toBe("running");
        expect(ctx.checkpointResult!._configurationCandidate).toMatchObject({
          candidateId: candidate.candidateId,
          phase: "discarded",
        });
        expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(0);
      });
      const next = await job();
      await owned(next, async () =>
        expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
      );
    }, 60000);
    it.each([false, true])(
      "publishes original reserved settlement cells through an actual durable nonempty maintenance route without any desired save with lost prepare response=%s",
      async (lost) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
          losePrepareResponse: lost,
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
        const coordinator = {
          ...host.row,
          Id: "c".repeat(64),
          State: lost ? "exited" : "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        host.setRows([host.row, coordinator]);
        host.setCreatingProcess(async (args) => {
          expect(args.at(-1)).toBe("data-manager");
          expect(args).not.toContain("--force-recreate");
          expect(dm!.preparePosts).toBe(0);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          coordinator.State = "running";
          host.setRows([host.row, coordinator]);
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
          const { record } = prospective.validatedConfigurationCandidateState(candidate),
            { prepareConfigurationMaintenance } = await import("../configuration-maintenance");
          // Corrupt only external HTTP copies of the ACTUAL issued packet;
          // the original still reaches the actual receiver unchanged.
          const actualFetch = globalThis.fetch;
          let rejectedControls = 0;
          const transport = !lost
            ? vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
                if (
                  String(input) === `${dm!.baseUrl}/executions/configuration-maintenance/prepare` &&
                  init?.method === "POST"
                ) {
                  const headers = new Headers(init.headers),
                    assertion = headers.get("x-openmapx-control-delegation");
                  if (!assertion) throw Error("Actual issued preparation control required");
                  const original = JSON.parse(Buffer.from(assertion, "base64url").toString("utf8"));
                  for (const changed of [
                    { ...original, signature: "a".repeat(86) },
                    { ...original, installationId: randomUUID() },
                  ]) {
                    const foreign = new Headers(headers);
                    foreign.set(
                      "x-openmapx-control-delegation",
                      Buffer.from(JSON.stringify(changed)).toString("base64url"),
                    );
                    const response = await actualFetch(input, { ...init, headers: foreign });
                    expect(response.status).toBe(403);
                    expect(
                      await fixture.sql`SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance' AND metadata->'configurationMaintenance'->'receipt'->>'maintenanceId'=${record.maintenanceId!}`,
                    ).toEqual([]);
                    expect(
                      existsSync(
                        join(
                          host.infraDir,
                          "control-private/data-manager/configuration-maintenance",
                          `${record.maintenanceId}.json`,
                        ),
                      ),
                    ).toBe(false);
                    await response.arrayBuffer();
                    rejectedControls++;
                  }
                }
                return actualFetch(input, init);
              })
            : undefined;
          let prepared: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
          try {
            prepared = await prepareConfigurationMaintenance(candidate).catch(async (error) => {
              throw Error(`${String(error)}; DM=${JSON.stringify(await dm!.diagnostics())}`);
            });
          } finally {
            transport?.mockRestore();
          }
          expect(rejectedControls).toBe(lost ? 0 : 2);
          const control = join(
            host.infraDir,
            "data/.admin-target-control/executions/ops-agent",
            `${record.prepareOperationKey}.configuration-settlement-control.json`,
          );
          expect(existsSync(control)).toBe(true);
          expect(prepared).toMatchObject({
            state: "prepared",
            preflight: "current",
            decision: null,
            generation: "not_started",
            followUp: "not_started",
          });
          const sourceControl = await import(
              "../../../../../packages/core/src/build-artifacts/control-authority"
            ),
            originalAuthority = restoreAdmittedControlExecution(installation, prepared.prepare);
          const rootControl = await import("@openmapx/core/build-artifacts");
          expect(() =>
            rootControl.verifyRetainedArtifactTargetRootRelease(originalAuthority),
          ).toThrow();
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
          expect(() =>
            sourceControl.verifyMaintenanceCoordinatorPrerequisite(installation, record),
          ).not.toThrow();
          expect(
            host.calls.filter((args) => args.includes("up") && args.includes("data-manager")),
          ).toHaveLength(1);
          expect(dm!.preparePosts).toBe(lost ? 1 : 3);
          expect(() =>
            sourceControl.withControlDelegationPublication(
              originalAuthority,
              "configuration-commit",
              () => undefined,
            ),
          ).toThrow("Original authorized configuration decision required");
          expect(statSync(control).size).toBe(8192);
          const { verifyControl, controlDigest } = await import("@openmapx/core/build-artifacts"),
            {
              configurationSettlementControlCellSchema,
              configurationSettlementReservationProjectionSchema,
              configurationSettlementCommitmentCellSchema,
              configurationSettlementDomains,
            } = await import(
              "../../../../../packages/core/src/build-artifacts/configuration-fence-settlement-records"
            );
          const original = readFileSync(control, "utf8"),
            pending = verifyControl(
              installation.publicKey,
              configurationSettlementDomains.control,
              JSON.parse(original),
              configurationSettlementControlCellSchema.shape.payload,
            ),
            projection = verifyControl(
              installation.publicKey,
              configurationSettlementDomains.signedProjection,
              pending.projection,
              configurationSettlementReservationProjectionSchema,
            );
          expect(projection).toMatchObject({
            maintenanceId: record.maintenanceId,
            candidateId: record.candidateId,
            ownerPrepare: { operationKey: record.prepareOperationKey },
            operation: {
              version: 2,
              maintenanceId: record.maintenanceId,
              candidateId: record.candidateId,
            },
          });
          expect(pending.binding).toBeNull();
          const commitmentPath = join(
              host.infraDir,
              "data/.admin-target-control/executions/ops-agent",
              `${record.prepareOperationKey}.configuration-settlement.json`,
            ),
            commitment = verifyControl(
              installation.publicKey,
              configurationSettlementDomains.reference,
              JSON.parse(readFileSync(commitmentPath, "utf8")),
              configurationSettlementCommitmentCellSchema.shape.payload,
            );
          expect(commitment).toMatchObject({
            phase: "uncommitted",
            identity: { settlementId: projection.settlementId },
          });
          expect(statSync(commitmentPath).size).toBe(16384);
          const location = JSON.parse(
              readFileSync(
                join(
                  host.infraDir,
                  "control-private/ops-agent/retention-locations",
                  `${controlDigest(projection.origin)}.json`,
                ),
                "utf8",
              ),
            ),
            progress = JSON.parse(
              readFileSync(
                join(
                  host.infraDir,
                  "control-private/ops-agent/retention-families",
                  location.name,
                  "progress.json",
                ),
                "utf8",
              ),
            );
          expect(progress.configurationSettlementSlot).toMatchObject({
            role: "ops-agent",
            state: "reserved",
            executionDigest: null,
            controlBindingDigest: null,
            settlementId: projection.settlementId,
            proposedExecutionAddress: projection.reservation.execution,
          });
          expect(progress.configurationSettlementSlot.allocatedDescriptorDigests).toHaveLength(6);
          const beforeCalls = host.calls.filter((args) => args.includes("up")).length;
          expect(await prepareConfigurationMaintenance(candidate)).toEqual(prepared);
          expect(readFileSync(control, "utf8")).toBe(original);
          expect(host.calls.filter((args) => args.includes("up"))).toHaveLength(beforeCalls);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          const guard =
            await fixture.sql`SELECT id,status,metadata FROM data_manager.jobs WHERE kind='configuration-maintenance'`;
          expect(guard).toHaveLength(1);
          expect(guard[0]!.metadata.configurationMaintenance).toMatchObject({
            guardState: "prepared",
            receipt: { state: "prepared", sequence: 0 },
            settlementReservation: { version: 2, settlementId: projection.settlementId },
          });
          expect(dm!.preparePosts).toBe(lost ? 1 : 3);
          const core = await import("@openmapx/core/build-artifacts"),
            authority = core.restoreAdmittedControlExecution(installation, prepared.prepare),
            lease = core.restoreArtifactTargetLeaseForSettlement(authority);
          try {
            await expect(
              core.settleArtifactTargetLeaseChild(
                lease,
                core.verifyControlEffectSettlement(installation, prepared.prepare),
              ),
            ).rejects.toThrow("Conclusive original maintenance");
            await expect(
              core.reconcileArtifactTargetLease({
                dataRoot: join(host.infraDir, "data"),
                leaseId: lease.leaseId,
                authority: core.verifyControlRecoveryAuthority(authority),
              }),
            ).rejects.toThrow("Conclusive original maintenance");
          } finally {
            core.closeArtifactTargetLeaseHandle(lease);
          }
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
        });
      },
      60000,
    );
    it.each(["source", "guard"] as const)(
      "refreshes actual durable nonempty maintenance inspection from the original API job with drift=%s",
      async (drift) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          ).rejects.toThrow("Conclusive original NoGuard closure required");
          expect(readdirSync(join(host.queue, ".candidates"))).toHaveLength(1);
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
              original = existsSync(envPath) ? readFileSync(envPath) : undefined;
            try {
              writeFileSync(
                envPath,
                Buffer.concat([
                  original ?? Buffer.alloc(0),
                  Buffer.from("\nTASK012_INSPECTION_SOURCE_DRIFT=changed\n"),
                ]),
                { mode: 0o600 },
              );
              expect(await maintenance.inspectConfigurationMaintenance(identity)).toMatchObject({
                state: "prepared",
                preflight: "drifted",
                sequence: prepared.sequence,
              });
            } finally {
              if (original) writeFileSync(envPath, original);
              else rmSync(envPath);
            }
          } else {
            await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid AND kind='configuration-maintenance'`;
            expect(await maintenance.inspectConfigurationMaintenance(identity)).toMatchObject({
              state: "prepared",
              preflight: "unavailable",
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          expect(readdirSync(host.queue).filter((name) => name.startsWith("cfg1_"))).toEqual([]);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          }),
          current = await import("../trusted-config-operations");
        await fixture.sql`ALTER TABLE service_secret ADD CONSTRAINT fixture_reject_desired_token CHECK (key <> 'TOKEN')`;
        const result = await current.applyTrustedConfigurationWithEvidence({
          ctx,
          actorId: ctx.jobId,
          kind: "vault.apply",
          serviceId: "data-manager",
          operationKey: candidate.operationKey,
          candidate,
          coordinatorMode: "require-running",
          followUp: "service-apply",
          expectedCurrentRevisionId: host.initial.revisionId,
        });
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
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
          leaseDirectory = join(host.infraDir, "data/.admin-target-control/leases", lease.leaseId),
          ownerPath = join(leaseDirectory, "owner.json"),
          ownerBytes = readFileSync(ownerPath),
          ownerInode = statSync(leaseDirectory).ino,
          originalAdmissionPath = join(
            host.infraDir,
            "control-private/ops-agent/executions",
            `${prepared.prepare.operationKey}.json`,
          ),
          originalAdmission = readFileSync(originalAdmissionPath),
          familiesPath = join(host.infraDir, "control-private/ops-agent/retention-locations"),
          families = readdirSync(familiesPath).sort();
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
            journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json")),
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
        expect(JSON.parse(readFileSync(ownerPath, "utf8")).payload.certificate).toEqual(
          JSON.parse(ownerBytes.toString()).payload.certificate,
        );
        expect(JSON.parse(readFileSync(ownerPath, "utf8")).payload.origin).toEqual(
          JSON.parse(ownerBytes.toString()).payload.origin,
        );
        expect(statSync(leaseDirectory).ino).toBe(ownerInode);
        expect(readFileSync(originalAdmissionPath)).toEqual(originalAdmission);
        expect(readdirSync(familiesPath).sort()).toEqual(families);
        const step = prepared.steps[0]!,
          projected = (await import("../admin-job-ops")).readProjection(ctx.checkpointResult)
            .operations[step.operationKey];
        expect(projected).toMatchObject({
          operation: step.operation,
          operationKey: step.operationKey,
          terminal: true,
          result: { outcome: "committed", revisionId: candidate.revisionId },
          receiptDelivery: { state: "confirmed" },
        });
        expect(await maintenance.executeConfigurationMaintenanceStep(candidate, 0)).toEqual(result);
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(true);
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
              readFileSync(join(host.infraDir, "data/ops-agent/jobs-v1.json"), "utf8"),
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
            projected = (await import("../admin-job-ops")).readProjection(ctx.checkpointResult)
              .operations[step.operationKey];
          expect(statSync(target).ino).toBe(statSync(join(source, "fixture.pbf")).ino);
          expect(projected).toMatchObject({
            operation: step.operation,
            terminal: true,
            receiptDelivery: { state: "confirmed" },
          });
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
          expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks/motis"))).toBe(
            true,
          );
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
    it.each(["contained", "retirement", "pointer-ack-loss"])(
      "settles the actual durable nonempty contained final after a known native generation noncommit through the current persister (mode=%s)",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                  ? basename(String(target)) === ".trusted-config-current"
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
            expect(
              existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
            ).toBe(true);
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
          expect(owner.apiControls.steps[0]!.receiptDelivery).not.toBeNull();
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(false);
          expect(
            existsSync(
              join(host.queue, ".candidates", `${owner.plan.operation.applyOperationKey}.json`),
            ),
          ).toBe(false);
          expect(
            host.calls.some(
              (value) =>
                value.includes("up") || value.includes("pull") || value.includes("restart"),
            ),
          ).toBe(false);
          if (mode === "retirement") {
            const core = await import("@openmapx/core/build-artifacts"),
              location = (role: string) =>
                join(
                  host.infraDir,
                  "control-private",
                  role,
                  "retention-locations",
                  `${core.controlDigest(owner.origin)}.json`,
                ),
              clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600000);
            try {
              for (
                let round = 0;
                round < 16 &&
                (existsSync(location("ops-agent")) || existsSync(location("data-manager")));
                round++
              ) {
                await core.reconcileControlRetention(installation, { maxFamilies: 64 });
                await dm!.reconcileRetention();
              }
              expect(
                existsSync(location("ops-agent")) || existsSync(location("data-manager")),
              ).toBe(false);
              expect(
                await fixture.sql`SELECT id FROM data_manager.jobs WHERE id=${owner.guardSource!.preparedReceipt.fenceId}::uuid`,
              ).toEqual([]);
              await app.close();
              closeControlInstallation(installation);
              const journal = await openOpsJobJournal(
                join(host.infraDir, "data/ops-agent/jobs-v1.json"),
              );
              installation = openControlInstallation({
                infraDir: host.infraDir,
                role: "ops-agent",
                serviceIds: host.loaded.map((value) => value.manifest.id),
              });
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
              clock.mockRestore();
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
    it.each([
      "component",
      "outer-api",
      "persister",
      "retirement",
      "sql-commit-ack-loss",
      "sql-update-rollback",
      "sql-session-absent",
      "sql-session-live",
      "publication-sender-ack",
      "publication-dm-ack",
      "publication-mirror",
      "publication-root-release",
      "publication-root-owner-ack",
      "publication-root-index",
      "sql-control-expired",
    ])(
      "constructs the actual durable nonempty applied final from production runtime configuration, mounts, image and readiness (mode=%s)",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
          loseSettlementCommitAcknowledgement: mode === "sql-commit-ack-loss",
          ...(mode === "sql-update-rollback"
            ? { settlementSqlFault: "update-ack-loss" as const }
            : mode === "sql-session-absent" || mode === "sql-session-live"
              ? { settlementSqlFault: "terminate-before-commit" as const }
              : {}),
          pauseSettlementBeforeCommit: mode === "sql-session-live",
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                  "com.docker.compose.project.working_dir": join(
                    host.infraDir,
                    ".trusted-config-generations",
                    candidate.revisionId,
                  ),
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
          if (
            mode === "persister" ||
            mode === "retirement" ||
            mode.startsWith("sql-") ||
            mode.startsWith("publication-")
          ) {
            const { AnchoredDirectory } = await import(
                "../../../../../packages/core/src/build-artifacts/filesystem"
              ),
              writeCell = AnchoredDirectory.prototype.write,
              expectedAckOwner =
                prospective.validatedConfigurationCandidateState(candidate).record
                  .prepareOperationKey,
              expectedOwnerName = `${prospective.validatedConfigurationCandidateState(candidate).record.maintenanceId}.json`;
            let interrupted = false,
              heldRootInode: number | undefined;
            const nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs"))
              .renameSync;
            const publicationFault =
              mode === "publication-root-index"
                ? vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
                    if (!interrupted && basename(String(target)) === expectedOwnerName) {
                      const payload = JSON.parse(readFileSync(source, "utf8")).payload;
                      if (
                        payload?.receipt?.state === "settled" &&
                        payload.apiControls?.settle?.result === null
                      ) {
                        interrupted = true;
                        expect(
                          existsSync(
                            join(host.infraDir, "data/.admin-target-control/locks/data-manager"),
                          ),
                        ).toBe(false);
                        throw Error(
                          "Synthetic actual released-owner rename failure after family preindex",
                        );
                      }
                    }
                    return nativeRename(source, target);
                  })
                : mode.startsWith("publication-")
                  ? vi.spyOn(AnchoredDirectory.prototype, "write").mockImplementation(function (
                      this: InstanceType<typeof AnchoredDirectory>,
                      name,
                      bytes,
                      ...args
                    ) {
                      const payload = JSON.parse(String(bytes))?.payload,
                        ack =
                          ((mode === "publication-sender-ack" &&
                            name === `${expectedAckOwner}.configuration-settlement-ack.json`) ||
                            (mode === "publication-dm-ack" &&
                              name !== `${expectedAckOwner}.configuration-settlement-ack.json` &&
                              name.endsWith(".configuration-settlement-ack.json"))) &&
                          Buffer.byteLength(bytes) === 1024 &&
                          typeof payload?.terminalDigest === "string",
                        mirror =
                          mode === "publication-mirror" &&
                          name === expectedOwnerName &&
                          payload?.metadata?.guardState === "settled" &&
                          payload.metadata.settlementControl?.tuple?.publication === "committed",
                        releasedOwner =
                          ["publication-root-release", "publication-root-owner-ack"].includes(
                            mode,
                          ) &&
                          name === expectedOwnerName &&
                          payload?.receipt?.state === "settled" &&
                          payload.apiControls?.settle?.result === null;
                      if (
                        (!interrupted || mode === "publication-mirror") &&
                        (ack || mirror || releasedOwner)
                      ) {
                        interrupted = true;
                        const rootLock = join(
                          host.infraDir,
                          "data/.admin-target-control/locks/data-manager",
                        );
                        if (ack || mirror) heldRootInode = statSync(rootLock).ino;
                        else expect(existsSync(rootLock)).toBe(false);
                        if (mode === "publication-root-owner-ack")
                          writeCell.call(this, name, bytes, ...args);
                        throw Error(
                          "Synthetic exact settlement publication filesystem interruption",
                        );
                      }
                      return writeCell.call(this, name, bytes, ...args);
                    })
                  : undefined;
            const expiredDelivery = Promise.withResolvers<number>();
            let originalExpiredControl:
              | {
                  key: string;
                  deadlineAt: number;
                  binding: Buffer;
                  dispatch: Buffer;
                  admission: Buffer;
                  effect: Buffer;
                  rootInode: number;
                }
              | undefined;
            const fetchActual = globalThis.fetch,
              delayControl =
                mode === "sql-control-expired"
                  ? vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
                      if (
                        options?.method === "POST" &&
                        String(input).startsWith(
                          `${dm!.baseUrl}/executions/configuration-maintenance/`,
                        ) &&
                        String(input).endsWith("/settle")
                      ) {
                        if (originalExpiredControl)
                          throw Error("A second settlement POST is forbidden");
                        const binding = readFileSync(
                            join(
                              host.infraDir,
                              "control-private/ops-agent/observations",
                              `${expectedAckOwner}.configuration-settlement-binding.json`,
                            ),
                          ),
                          { installationState } = await import(
                            "../../../../../packages/core/src/build-artifacts/control-authority"
                          ),
                          { verifyControl } = await import(
                            "../../../../../packages/core/src/build-artifacts/control-records"
                          ),
                          records = await import(
                            "../../../../../packages/core/src/build-artifacts/configuration-fence-settlement-records"
                          ),
                          envelope = verifyControl(
                            installationState(installation).installation.publicKey,
                            records.configurationSettlementDomains.binding,
                            JSON.parse(binding.toString()),
                            records.configurationSettlementControlEnvelopeSchema,
                          ),
                          key = envelope.execution.operationKey;
                        originalExpiredControl = {
                          key,
                          deadlineAt: envelope.controlDeadlineAt,
                          binding,
                          dispatch: readFileSync(
                            join(
                              host.infraDir,
                              "control-private/ops-agent/observations",
                              `${expectedAckOwner}.configuration-settlement-dispatch.json`,
                            ),
                          ),
                          admission: readFileSync(
                            join(
                              host.infraDir,
                              "control-private/data-manager/observations",
                              `${key}.configuration-settlement-admission.json`,
                            ),
                          ),
                          effect: readFileSync(
                            join(
                              host.infraDir,
                              "control-private/data-manager/observations",
                              `${key}.configuration-settlement-effect.json`,
                            ),
                          ),
                          rootInode: statSync(
                            join(host.infraDir, "data/.admin-target-control/locks/data-manager"),
                          ).ino,
                        };
                        expect(envelope.controlDeadlineAt - envelope.controlStartedAt).toBe(60000);
                        expect(Date.now()).toBeLessThan(envelope.controlDeadlineAt);
                        // External delayed original packet, not a retry/new assertion. The
                        // transport's own15s timeout still ends the original waiter; a
                        // network can deliver its already-sent bytes after cancellation.
                        await nativeDelay(
                          Math.max(1, envelope.controlDeadlineAt - Date.now() + 50),
                        );
                        try {
                          const response = await fetchActual(input, {
                            ...options,
                            signal: undefined,
                          });
                          expiredDelivery.resolve(response.status);
                          return response;
                        } catch (error) {
                          expiredDelivery.reject(error);
                          throw error;
                        }
                      }
                      return fetchActual(input, options);
                    })
                  : undefined;
            const current = await import("../trusted-config-operations"),
              application = current.applyTrustedConfigurationWithEvidence({
                ctx,
                actorId: ctx.jobId,
                kind: "vault.apply",
                serviceId: "data-manager",
                operationKey: candidate.operationKey,
                candidate,
                coordinatorMode: "require-running",
                followUp: "service-apply",
                expectedCurrentRevisionId: host.initial.revisionId,
              });
            void application.catch(() => {});
            if (mode === "sql-control-expired") {
              let lateStatus: number;
              try {
                await expect(application).rejects.toBeInstanceOf(
                  (await import("../ops-client")).OpsObservationPending,
                );
                lateStatus = await expiredDelivery.promise;
              } finally {
                delayControl!.mockRestore();
              }
              const original = originalExpiredControl!;
              expect(original).toBeDefined();
              expect(Date.now()).toBeGreaterThan(original.deadlineAt);
              expect([403, 409]).toContain(lateStatus!);
              expect(dm!.settlePosts).toBe(1);
              const store = await import(
                  "../../../../ops-agent/src/configuration-maintenance-store"
                ),
                preparedReceipt = (
                  ctx.checkpointResult!._configurationMaintenance as {
                    receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
                  }
                ).receipt,
                authority = restoreAdmittedControlExecution(installation, preparedReceipt.prepare),
                before = store.readOwnedConfigurationMaintenance(authority),
                [sqlBefore] =
                  await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${before.guardSource!.preparedReceipt.fenceId}::uuid`;
              expect(sqlBefore!.metadata.configurationMaintenance).toMatchObject({
                guardState: "prepared",
                receipt: { state: "prepared", sequence: 0 },
              });
              expect(
                sqlBefore!.metadata.configurationMaintenance.settlementControl,
              ).toBeUndefined();
              expect(before.final).not.toBeNull();
              expect(before.apiControls.settle!.result).toBeNull();
              await maintenance.inspectConfigurationMaintenance(preparedReceipt.binding);
              const after = store.readOwnedConfigurationMaintenance(authority);
              expect(canonicalJson(after.final) === canonicalJson(before.final)).toBe(true);
              expect(after.apiControls.settle!.result).toBeNull();
              expect(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/ops-agent/observations",
                    `${expectedAckOwner}.configuration-settlement-binding.json`,
                  ),
                ).equals(original.binding),
              ).toBe(true);
              expect(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/ops-agent/observations",
                    `${expectedAckOwner}.configuration-settlement-dispatch.json`,
                  ),
                ).equals(original.dispatch),
              ).toBe(true);
              expect(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/data-manager/observations",
                    `${original.key}.configuration-settlement-admission.json`,
                  ),
                ).equals(original.admission),
              ).toBe(true);
              expect(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/data-manager/observations",
                    `${original.key}.configuration-settlement-effect.json`,
                  ),
                ).equals(original.effect),
              ).toBe(true);
              expect(
                await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${before.guardSource!.preparedReceipt.fenceId}::uuid`,
              ).toEqual([sqlBefore]);
              expect(
                statSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")).ino,
              ).toBe(original.rootInode);
              expect(dm!.settlePosts).toBe(1);
              expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(
                1,
              );
              console.info(
                JSON.stringify({
                  proof: "actual-original-settlement-control-expired",
                  lateOriginalPacketStatus: lateStatus!,
                  realDeadlineElapsed: true,
                  originalControlUnchanged: true,
                  sqlUnchanged: true,
                  guardAndRootRetained: true,
                  secondPost: false,
                }),
              );
              return;
            }
            if (mode.startsWith("publication-")) {
              let publicationFailure: unknown;
              try {
                await application;
              } catch (error) {
                publicationFailure = error;
              } finally {
                publicationFault!.mockRestore();
              }
              expect(publicationFailure).toBeInstanceOf(
                (await import("../ops-client")).OpsObservationPending,
              );
              expect(interrupted).toBe(true);
              const store = await import(
                  "../../../../ops-agent/src/configuration-maintenance-store"
                ),
                core = await import("@openmapx/core/build-artifacts"),
                ownerRecords = await import(
                  "../../../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records"
                ),
                original = (
                  ctx.checkpointResult!._configurationMaintenance as {
                    receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
                  }
                ).receipt,
                authority = restoreAdmittedControlExecution(installation, original.prepare),
                // Supporting comparison only: the physical old owner is signed,
                // but its family index pins the next exact release preimage. This
                // snapshot supplies no production repair/settlement authority.
                before =
                  mode === "publication-root-index"
                    ? core.verifyControl(
                        installation.publicKey,
                        "openmapx-configuration-maintenance-owner-v2",
                        JSON.parse(
                          readFileSync(
                            join(
                              host.infraDir,
                              "control-private/ops-agent/configuration-maintenance",
                              expectedOwnerName,
                            ),
                            "utf8",
                          ),
                        ),
                        ownerRecords.configurationMaintenanceOwnerRecordSchema,
                      )
                    : store.readOwnedConfigurationMaintenance(authority),
                [sqlBefore] =
                  await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${before.guardSource!.preparedReceipt.fenceId}::uuid`;
              expect(before.final).not.toBeNull();
              expect(before.apiControls.settle!.result).toBeNull();
              expect(sqlBefore!.metadata.configurationMaintenance).toMatchObject({
                guardState: "settled",
                receipt: { state: "prepared" },
                settlementControl: {
                  tuple: { result: { state: "settled" }, publication: "committed" },
                },
              });
              const releasedBefore = [
                "publication-sender-ack",
                "publication-dm-ack",
                "publication-mirror",
              ].includes(mode)
                ? null
                : core.verifyRetainedArtifactTargetRootRelease(authority);
              if (!releasedBefore)
                expect(
                  statSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager"))
                    .ino,
                ).toBe(heldRootInode);
              else
                expect(
                  existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
                ).toBe(false);
              expect(dm!.settlePosts).toBe(1);
              if (mode === "publication-root-index") {
                expect(() => store.readOwnedConfigurationMaintenance(authority)).toThrow();
                await app.close();
                closeControlInstallation(installation);
                const journal = await openOpsJobJournal(
                  join(host.infraDir, "data/ops-agent/jobs-v1.json"),
                );
                installation = openControlInstallation({
                  infraDir: host.infraDir,
                  role: "ops-agent",
                  serviceIds: host.loaded.map((value) => value.manifest.id),
                });
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
                vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
              }
              // Actual inspection can repair ONLY this already committed immutable
              // final/SQL publication chain; no new attestation or mutation POST.
              expect(
                await maintenance.inspectConfigurationMaintenance(original.binding),
              ).toMatchObject({ state: "settled", dmFence: { state: "settled" } });
              const observedAuthority = restoreAdmittedControlExecution(
                  installation,
                  original.prepare,
                ),
                final = store.readOwnedConfigurationMaintenance(observedAuthority);
              expect(canonicalJson(final.final) === canonicalJson(before.final)).toBe(true);
              expect(canonicalJson(final.inspection) === canonicalJson(before.inspection)).toBe(
                true,
              );
              expect(final.apiControls.settle!.operation).toEqual(
                before.apiControls.settle!.operation,
              );
              if (releasedBefore)
                expect(
                  core.verifyRetainedArtifactTargetRootRelease(observedAuthority).releasedAt,
                ).toBe(releasedBefore.releasedAt);
              expect(
                await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${before.guardSource!.preparedReceipt.fenceId}::uuid`,
              ).toEqual([sqlBefore]);
              expect(
                (
                  await prospective.persistAndApplyProspectiveConfiguration(candidate, {
                    coordinatorMode: "require-running",
                  })
                ).application,
              ).toMatchObject({ outcome: "committed", followUp: "complete" });
              expect(
                existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
              ).toBe(false);
              expect(
                existsSync(
                  join(
                    host.queue,
                    ".candidates",
                    `${before.plan.operation.applyOperationKey}.json`,
                  ),
                ),
              ).toBe(false);
              expect(dm!.settlePosts).toBe(1);
              expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(
                1,
              );
              return;
            }
            if (
              mode === "sql-update-rollback" ||
              mode === "sql-session-absent" ||
              mode === "sql-session-live"
            ) {
              if (mode === "sql-session-live") {
                // Observe an actual still-live reserved transaction, not a fake
                // prepared row or public status. The external edge is paused only
                // after its real UPDATE and before its COMMIT transport call.
                await dm!.settlementCommitEntered;
                try {
                  const store = await import(
                      "../../../../ops-agent/src/configuration-maintenance-store"
                    ),
                    original = (
                      ctx.checkpointResult!._configurationMaintenance as {
                        receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
                      }
                    ).receipt,
                    owner = store.readOwnedConfigurationMaintenance(
                      restoreAdmittedControlExecution(installation, original.prepare),
                    ),
                    key = owner.plan.reservations.find(
                      (value) => value.phase === "configuration-fence-settle",
                    )!.execution.operationKey,
                    effectPath = join(
                      host.infraDir,
                      "control-private/data-manager/observations",
                      `${key}.configuration-settlement-effect.json`,
                    ),
                    bytes = readFileSync(effectPath),
                    effect = JSON.parse(bytes.toString()).payload;
                  expect(effect).toMatchObject({
                    phase: "attempted",
                    terminal: null,
                    observation: null,
                  });
                  const sessions =
                    await fixture.sql`SELECT backend_start::text AS backend_start,application_name FROM pg_stat_activity WHERE pid=${effect.sqlSession.pid}::int`;
                  expect(sessions).toHaveLength(1);
                  expect(sessions[0]).toMatchObject({
                    backend_start: effect.sqlSession.backendStart,
                    application_name: `omx-config-settle:${effect.sqlSession.sessionNonce}`,
                  });
                  const observed = await dm!.inspectWithOriginalWitness();
                  expect(observed).toMatchObject({
                    status: 409,
                    body: { message: "Invalid data-manager response" },
                  });
                  expect(readFileSync(effectPath)).toEqual(bytes);
                  expect(owner.apiControls.settle!.result).toBeNull();
                  expect(
                    existsSync(
                      join(host.infraDir, "data/.admin-target-control/locks/data-manager"),
                    ),
                  ).toBe(true);
                  const replacement = await ownedDataManager({
                    sql: fixture.sql,
                    infraDir: host.infraDir,
                    serviceIds: host.loaded.map((value) => value.manifest.id),
                  });
                  try {
                    expect(replacement.startupRecoveryRequired).toBe(true);
                    expect(
                      (
                        await fetch(`${replacement.baseUrl}/status`, {
                          headers: { authorization: `Bearer ${replacement.token}` },
                        })
                      ).status,
                    ).toBe(200);
                    await expect(replacement.assertDataAdmission()).rejects.toThrow(
                      "configuration_maintenance_busy",
                    );
                    expect(readFileSync(effectPath)).toEqual(bytes);
                  } finally {
                    await replacement.close();
                  }
                } finally {
                  dm!.releaseSettlementCommit();
                  await application.catch(() => {});
                }
              }
              await expect(application).rejects.toBeInstanceOf(
                (await import("../ops-client")).OpsObservationPending,
              );
              const original = (
                ctx.checkpointResult!._configurationMaintenance as {
                  receipt: import("@openmapx/core/ops").ConfigurationMaintenanceReceipt;
                }
              ).receipt;
              const store = await import(
                  "../../../../ops-agent/src/configuration-maintenance-store"
                ),
                owner = store.readOwnedConfigurationMaintenance(
                  restoreAdmittedControlExecution(installation, original.prepare),
                ),
                stateModule = await import(
                  "../../../../../packages/core/src/build-artifacts/control-authority"
                ),
                records = await import(
                  "../../../../../packages/core/src/build-artifacts/configuration-fence-settlement-records"
                ),
                crypto = await import(
                  "../../../../../packages/core/src/build-artifacts/control-records"
                ),
                key = owner.plan.reservations.find(
                  (value) => value.phase === "configuration-fence-settle",
                )!.execution.operationKey,
                effectPath = join(
                  host.infraDir,
                  "control-private/data-manager/observations",
                  `${key}.configuration-settlement-effect.json`,
                ),
                bytes = readFileSync(effectPath),
                effect = crypto.verifyControl(
                  stateModule.installationState(installation).publicKeys["data-manager"],
                  records.configurationSettlementDomains.effect,
                  JSON.parse(bytes.toString()),
                  records.configurationSettlementEffectSchema,
                );
              expect(effect).toMatchObject({
                phase: "contained_not_settled",
                terminal: null,
                observation: {
                  state: "contained_not_settled",
                  containment:
                    mode === "sql-update-rollback"
                      ? "explicit_rollback"
                      : "original_session_absent",
                },
              });
              expect(effect.observation!.sqlSession).toEqual(effect.sqlSession);
              expect(effect.observation).not.toHaveProperty("terminalAt");
              expect(effect.observation).not.toHaveProperty("terminalDigest");
              expect(owner.apiControls.settle!.result).toBeNull();
              expect(
                existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
              ).toBe(true);
              expect(JSON.stringify(dm!.fenceInspections.at(-1)?.body)).toContain(
                '"state":"recovery_required"',
              );
              const [saved] =
                await fixture.sql`SELECT metadata->'configurationMaintenance' AS value FROM data_manager.jobs WHERE id=${owner.guardSource!.preparedReceipt.fenceId}::uuid`;
              expect(saved!.value).toMatchObject({
                guardState: "prepared",
                receipt: { sequence: 0, state: "prepared" },
              });
              expect(saved!.value.settlementControl).toBeUndefined();
              expect(dm!.settlementSqlIo).toEqual({ commits: 0, updates: 1 });
              expect(dm!.settlementContainmentIo).toEqual({
                rollbacks: mode === "sql-update-rollback" ? 1 : 0,
                terminated: mode !== "sql-update-rollback",
              });
              expect(dm!.settlePosts).toBe(1);
              const old = dm!;
              await old.stopForRestart();
              try {
                dm = await ownedDataManager({
                  sql: fixture.sql,
                  infraDir: host.infraDir,
                  serviceIds: host.loaded.map((value) => value.manifest.id),
                });
                expect(
                  (
                    await fetch(`${dm.baseUrl}/status`, {
                      headers: { authorization: `Bearer ${dm.token}` },
                    })
                  ).status,
                ).toBe(200);
                expect(readFileSync(effectPath)).toEqual(bytes);
                const [after] =
                  await fixture.sql`SELECT metadata->'configurationMaintenance' AS value FROM data_manager.jobs WHERE id=${owner.guardSource!.preparedReceipt.fenceId}::uuid`;
                expect(after!.value).toEqual(saved!.value);
                expect(
                  existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
                ).toBe(true);
              } finally {
                await old.close();
              }
              return;
            }
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
              existsSync(
                join(host.queue, ".candidates", `${prepared.binding.applyOperationKey}.json`),
              ),
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
            expect(
              existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
            ).toBe(false);
          } else if (mode === "component") {
            const shapes = await import(
                "../../../../../packages/core/src/build-artifacts/configuration-maintenance-docker-records"
              ),
              id = "d".repeat(64),
              original = shapes.maintenanceDockerContainerSchema.parse(installedDocker[id]),
              path = join(
                host.infraDir,
                "control-private/ops-agent/configuration-maintenance",
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
          if (mode === "sql-commit-ack-loss") {
            expect(dm!.settlementSqlIo).toEqual({ commits: 1, updates: 1 });
            expect(owner.receipt).toMatchObject({
              state: "settled",
              dmFence: { state: "settled" },
            });
            expect(
              existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
            ).toBe(false);
            const [saved] =
              await fixture.sql`SELECT metadata->'configurationMaintenance' AS value FROM data_manager.jobs WHERE id=${owner.guardSource!.preparedReceipt.fenceId}::uuid`;
            expect(saved!.value).toMatchObject({
              guardState: "settled",
              settlementControl: { expectedDmSequence: 0, tuple: { publication: "committed" } },
            });
            const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding);
            expect(observed.dmFence).toEqual(owner.receipt.dmFence);
            expect(dm!.settlementSqlIo).toEqual({ commits: 1, updates: 1 });
            const [after] =
              await fixture.sql`SELECT metadata->'configurationMaintenance' AS value FROM data_manager.jobs WHERE id=${owner.guardSource!.preparedReceipt.fenceId}::uuid`;
            expect(after!.value).toEqual(saved!.value);
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
          expect(owner.inspection!.payload.requiredChecks.map((check) => check.check)).toEqual(
            expect.arrayContaining(["configuration", "image", "mount", "readiness"]),
          );
          expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
          if (mode === "retirement") {
            const core = await import("@openmapx/core/build-artifacts"),
              retentionPath = (role: string) =>
                join(
                  host.infraDir,
                  "control-private",
                  role,
                  "retention-locations",
                  `${core.controlDigest(owner.origin)}.json`,
                ),
              clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600000);
            try {
              for (
                let round = 0;
                round < 16 &&
                (existsSync(retentionPath("ops-agent")) ||
                  existsSync(retentionPath("data-manager")));
                round++
              ) {
                await core.reconcileControlRetention(installation, { maxFamilies: 64 });
                await dm!.reconcileRetention();
              }
              expect(existsSync(retentionPath("ops-agent"))).toBe(false);
              expect(existsSync(retentionPath("data-manager"))).toBe(false);
              expect(
                await fixture.sql`SELECT id FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`,
              ).toEqual([]);
              expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
                candidate.revisionId,
              );
            } finally {
              clock.mockRestore();
            }
          }
        });
        if (mode === "sql-control-expired") {
          const next = await job();
          await expect(owned(next, async () => undefined)).rejects.toThrow(
            "Configuration writer unavailable",
          );
        } else if (mode.startsWith("publication-")) {
          const next = await job();
          await owned(next, async () =>
            expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
          );
        }
      },
      180000,
    );
    it("rejects a real durable nonempty middle-owner grant with only the original pending decision witness", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                  value: "synthetic-no-decision-credential",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          witnessPath = join(
            host.infraDir,
            "data/.admin-target-control/executions/ops-agent",
            `${prepared.prepare.operationKey}.configuration-maintenance.json`,
          ),
          pending = readFileSync(witnessPath),
          decision = await prospective.commitProspectiveConfigurationMaintenance(candidate);
        expect(JSON.parse(pending.toString()).payload).toMatchObject({
          decision: null,
          generation: null,
        });
        await maintenance.decideConfigurationMaintenance(decision);
        await maintenance.executeConfigurationMaintenanceStep(candidate, 0);
        const nativeFetch = globalThis.fetch,
          core = await import("@openmapx/core/build-artifacts");
        let denied = 0,
          validGrant = false,
          leafKey = "";
        const transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
          if (
            !String(args[0]).endsWith("/executions/generation-hardlinks") ||
            args[1]?.method !== "POST"
          )
            return nativeFetch(...args);
          const headers = new Headers(args[1].headers),
            grant = core.inspectArtifactDelegation({
              installation,
              dataRoot: join(host.infraDir, "data"),
              assertion: headers.get("x-openmapx-control-delegation")!,
            });
          leafKey = grant.execution.operationKey;
          validGrant =
            grant.kind === "generation-hardlinks" &&
            grant.parent.operationKey === prepared.steps[1]!.operationKey &&
            grant.owner.operationKey === prepared.prepare.operationKey;
          const current = readFileSync(witnessPath);
          // Named native shared-publication rollback only; both packets are the
          // actual producer's signatures. No private source/grant is fabricated.
          writeFileSync(witnessPath, pending);
          try {
            const response = await nativeFetch(...args);
            denied = response.status;
            observation.abort();
            return response;
          } finally {
            writeFileSync(witnessPath, current);
          }
        });
        try {
          await expect(
            maintenance.executeConfigurationMaintenanceStep(candidate, 1),
          ).rejects.toMatchObject({ name: "OpsObservationPending" });
        } finally {
          transport.mockRestore();
        }
        expect(validGrant).toBe(true);
        expect(denied).toBe(409);
        expect(
          await fixture.sql`SELECT id FROM data_manager.jobs WHERE kind='generation-hardlinks' AND operation_key=${leafKey}`,
        ).toHaveLength(0);
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(true);
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
      });
    }, 120000);
    it.each(["expired", "host-source"])(
      "refuses actual durable nonempty committed continue after %s drift without admitting any effect",
      async (reason) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
            expect(
              existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
            ).toBe(true);
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
              "control-private/ops-agent/configuration-maintenance",
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
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
          expect(dm!.preparePosts).toBe(1);
        });
      },
      60000,
    );
    it("serializes competing actual durable nonempty first settle observations into one original winner", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                  value: "synthetic-settle-race-credential",
                },
              ],
            },
          }),
          maintenance = await import("../configuration-maintenance"),
          prepared = await maintenance.prepareConfigurationMaintenance(candidate),
          decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
        await maintenance.decideConfigurationMaintenance(decision);
        const observed = await maintenance.inspectConfigurationMaintenance(prepared.binding),
          { configurationMaintenanceSettleRequestDigest } = await import("@openmapx/core/ops"),
          request = {
            kind: "configurationMaintenance.settle" as const,
            maintenanceId: prepared.binding.maintenanceId,
            candidateId: candidate.candidateId,
            prepareOperationKey: prepared.prepare.operationKey,
            prepareFingerprint: prepared.prepare.operationFingerprint,
            planDigest: prepared.planDigest,
            decisionId: decision.decisionId,
            expectedSequence: observed.sequence,
            evidenceDigest: configurationMaintenanceSettleRequestDigest(observed),
          },
          fetchActual = globalThis.fetch,
          frames: number[] = [],
          transport = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, options) => {
            if (
              options?.method === "POST" &&
              typeof options.body === "string" &&
              JSON.parse(options.body).operation?.kind === "configurationMaintenance.settle"
            ) {
              // Duplicate exact real checkpointed request bytes/HMAC at the named
              // transport edge. Both reach the receiver; no alternate key/root.
              const responses = await Promise.all([
                fetchActual(input, options),
                fetchActual(input, options),
              ]);
              frames.push(...responses.map((response) => response.status));
              await responses[1]!.arrayBuffer();
              return responses[0]!;
            }
            return fetchActual(input, options);
          });
        try {
          try {
            expect(await maintenance.settleConfigurationMaintenance(request)).toMatchObject({
              state: "settled",
            });
          } catch (error) {
            expect(error).toBeInstanceOf(
              (await import("../admin-job-failure")).JobObservationPending,
            );
          }
        } finally {
          transport.mockRestore();
        }
        expect(frames).toHaveLength(2);
        expect(frames).toContain(202);
        expect(frames.every((status) => status === 202 || status === 409)).toBe(true);
        // If the caller saw the losing conflict, its ORIGINAL attempted address
        // is now lookup-only. This is reconciliation, never a second POST.
        expect(await maintenance.settleConfigurationMaintenance(request)).toMatchObject({
          state: "settled",
        });
        expect(frames).toHaveLength(2);
        const store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
          owner = store.readOwnedConfigurationMaintenance(
            restoreAdmittedControlExecution(installation, prepared.prepare),
          );
        expect(owner.apiControls.settle).toMatchObject({
          operation: request,
          checkedSequence: observed.sequence,
          requestEvidenceDigest: request.evidenceDigest,
          result: { state: "settled", generation: "not_started", followUp: "not_started" },
        });
        expect(owner.final).not.toBeNull();
        expect(owner.final!.evidenceDigest).not.toBe(request.evidenceDigest);
        expect(owner.plan.prepare).toEqual(prepared.prepare);
        expect(dm!.settlePosts).toBe(1);
        const { createApiOpsClient } = await import("../ops-client"),
          retained = ctx.checkpointResult!._configurationMaintenanceSettle as {
            delivery: { root: { operationKey: string; requestedDeadlineAt: number } };
          },
          lookedUp = await createApiOpsClient().lookup(
            request,
            retained.delivery.root.operationKey,
            { execution: { requestedDeadlineAt: retained.delivery.root.requestedDeadlineAt } },
          );
        expect(lookedUp).toMatchObject({
          state: "succeeded",
          operationId: owner.apiControls.settle!.execution.executionId,
          result: { state: "settled" },
        });
        expect(
          canonicalJson(
            store.readOwnedConfigurationMaintenance(
              restoreAdmittedControlExecution(installation, prepared.prepare),
            ).final,
          ) === canonicalJson(owner.final),
        ).toBe(true);
        expect(dm!.settlePosts).toBe(1);
        console.info(
          JSON.stringify({
            proof: "outer-settle-original-first-cas-winner",
            postStatuses: frames,
            dmSettlementPosts: dm!.settlePosts,
            checkedSequence: owner.apiControls.settle!.checkedSequence,
            originalFinalUnchanged: true,
            sameAddressLookupOnly: true,
          }),
        );
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
      });
    }, 60000);
    it("retains actual durable nonempty accepted but ineligible settle intent as unknown across agent restart with read-only health", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
            await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`;
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
            "control-private/ops-agent/configuration-maintenance",
            `${prepared.binding.maintenanceId}.json`,
          ),
          original = readFileSync(path);
        await app.close();
        closeControlInstallation(installation);
        const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
        installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        app = buildOpsAgentServer({
          tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
          runtime: host.runtime,
          resourceClaimer: host.claimer,
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
            await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`
          )[0],
        ).toEqual(beforeSql);
        await expect(dm!.receiver.admitLocal({ kind: "download-fonts" })).rejects.toThrow(
          "configuration_maintenance_busy",
        );
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(true);
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                "control-private/ops-agent/executions",
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
            expect(
              existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
            ).toBe(false);
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
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
            JSON.parse(readFileSync(source, "utf8")).payload?.apiControls?.settle?.result
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
          owner = core.verifyControl(
            installation.publicKey,
            "openmapx-configuration-maintenance-owner-v2",
            JSON.parse(
              readFileSync(
                join(
                  host.infraDir,
                  "control-private/ops-agent/configuration-maintenance",
                  `${prepared.binding.maintenanceId}.json`,
                ),
                "utf8",
              ),
            ),
            records.configurationMaintenanceOwnerRecordSchema,
          ),
          released = core.verifyRetainedArtifactTargetRootRelease(authority),
          originalFinal = JSON.stringify(owner.final),
          originalInspection = JSON.stringify(owner.inspection),
          [originalSql] =
            await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`;
        expect(owner.receipt.state).toBe("settled");
        expect(owner.apiControls.settle!.result).toBeNull();
        await app.close();
        closeControlInstallation(installation);
        const journal = await openOpsJobJournal(join(host.infraDir, "data/ops-agent/jobs-v1.json"));
        installation = openControlInstallation({
          infraDir: host.infraDir,
          role: "ops-agent",
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        app = buildOpsAgentServer({
          tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
          runtime: host.runtime,
          resourceClaimer: host.claimer,
          journal,
          controlInstallation: installation,
        });
        vi.stubEnv("OPS_AGENT_URL", await app.listen({ host: "127.0.0.1", port: 0 }));
        const result = await maintenance.settleConfigurationMaintenance(request),
          recovered = store.readOwnedConfigurationMaintenance(
            restoreAdmittedControlExecution(installation, prepared.prepare),
          );
        expect(result).toEqual(owner.receipt);
        expect(recovered.apiControls.settle).toMatchObject({
          operation: request,
          checkedSequence: observed.sequence,
          completedAt: released.releasedAt,
          requestEvidenceDigest: request.evidenceDigest,
          result: { state: "settled" },
        });
        expect(recovered.apiControls.settle!.receiptDelivery).not.toBeNull();
        expect(JSON.stringify(recovered.final)).toBe(originalFinal);
        expect(JSON.stringify(recovered.inspection)).toBe(originalInspection);
        expect(
          (
            await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`
          )[0],
        ).toEqual(originalSql);
        expect(
          existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
        ).toBe(false);
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
          ),
        ).toBe(false);
      });
    }, 60000);
    it.each(["journal", "retirement"])(
      "settles actual durable nonempty unused maintenance through the original API control and retains its canonical delivery (%s)",
      async (mode) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                    value: "synthetic-api-unused-final-credential",
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
          expect(owner.apiControls.settle!.receiptDelivery).not.toBeNull();
          expect(owner.final!.evidenceDigest).not.toBe(request.evidenceDigest);
          const final = JSON.stringify(owner.final),
            inspection = JSON.stringify(owner.inspection),
            [beforeSql] =
              await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`;
          expect(await maintenance.settleConfigurationMaintenance(request)).toEqual(result);
          expect(JSON.stringify(store.readOwnedConfigurationMaintenance(authority).final)).toBe(
            final,
          );
          expect(
            JSON.stringify(store.readOwnedConfigurationMaintenance(authority).inspection),
          ).toBe(inspection);
          expect(
            (
              await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`
            )[0],
          ).toEqual(beforeSql);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(false);
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          await prospective.discardUnusedPreparedProspectiveConfiguration(candidate);
          expect(
            existsSync(
              join(host.queue, ".candidates", `${prepared.binding.applyOperationKey}.json`),
            ),
          ).toBe(false);
          expect(
            (ctx.checkpointResult!._configurationCandidate as Record<string, unknown>).phase,
          ).toBe("discarded");
          await app.close();
          closeControlInstallation(installation);
          const journal = await openOpsJobJournal(
              join(host.infraDir, "data/ops-agent/jobs-v1.json"),
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
          app = buildOpsAgentServer({
            tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
            runtime: host.runtime,
            resourceClaimer: host.claimer,
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
          if (mode === "retirement") {
            const core = await import("@openmapx/core/build-artifacts"),
              records = await import(
                "../../../../../packages/core/src/build-artifacts/configuration-fence-settlement-records"
              ),
              control = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "data/.admin-target-control/executions/ops-agent",
                    `${prepared.prepare.operationKey}.configuration-settlement-control.json`,
                  ),
                  "utf8",
                ),
              ),
              envelope = core.verifyControl(
                installation.publicKey,
                records.configurationSettlementDomains.control,
                control.payload.binding,
                records.configurationSettlementControlEnvelopeSchema,
              ),
              sqlControl = beforeSql!.metadata.configurationMaintenance.settlementControl,
              retentionPath = (role: string) =>
                join(
                  host.infraDir,
                  "control-private",
                  role,
                  "retention-locations",
                  `${core.controlDigest(owner.origin)}.json`,
                ),
              clock = vi
                .spyOn(Date, "now")
                .mockReturnValue(sqlControl.tuple.terminalAt + 72 * 3600000 - 1);
            try {
              await core.reconcileControlRetention(installation, { maxFamilies: 64 });
              await dm!.reconcileRetention();
              expect(existsSync(retentionPath("ops-agent"))).toBe(true);
              expect(existsSync(retentionPath("data-manager"))).toBe(true);
              const ackPath = join(
                  host.infraDir,
                  "control-private/data-manager/observations",
                  `${envelope.execution.operationKey}.configuration-settlement-ack.json`,
                ),
                originalAck = readFileSync(ackPath),
                corrupt = Buffer.from(originalAck);
              corrupt[12] ^= 1;
              clock.mockReturnValue(sqlControl.tuple.terminalAt + 96 * 3600000);
              try {
                writeFileSync(ackPath, corrupt);
                await core.reconcileControlRetention(installation, { maxFamilies: 64 });
                await dm!.reconcileRetention();
                expect(existsSync(retentionPath("data-manager"))).toBe(true);
                expect(
                  await fixture.sql`SELECT id FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`,
                ).toHaveLength(1);
              } finally {
                writeFileSync(ackPath, originalAck);
              }
              for (
                let round = 0;
                round < 16 &&
                (existsSync(retentionPath("ops-agent")) ||
                  existsSync(retentionPath("data-manager")));
                round++
              ) {
                await core.reconcileControlRetention(installation, { maxFamilies: 64 });
                await dm!.reconcileRetention();
              }
              const diagnostics = ["ops-agent", "data-manager"].map((role) => {
                if (!existsSync(retentionPath(role))) return { role, retired: true };
                const location = JSON.parse(readFileSync(retentionPath(role), "utf8"));
                const progress = JSON.parse(
                  readFileSync(
                    join(
                      host.infraDir,
                      "control-private",
                      role,
                      "retention-families",
                      location.name,
                      "progress.json",
                    ),
                    "utf8",
                  ),
                );
                return {
                  role,
                  phase: progress.phase,
                  lastError: progress.lastError,
                  slot: progress.configurationSettlementSlot?.state,
                  executions: Object.values<{
                    known: boolean;
                    requiresJournal: boolean;
                    journalContained: boolean;
                    canonicalDigest?: string;
                    terminalDigest?: string;
                    execution: { operationKey: string };
                  }>(progress.executions).map((value) => ({
                    key: value.execution.operationKey,
                    known: value.known,
                    requiresJournal: value.requiresJournal,
                    journalContained: value.journalContained,
                    canonical: value.canonicalDigest,
                    terminal: value.terminalDigest,
                  })),
                };
              });
              expect(existsSync(retentionPath("ops-agent")), JSON.stringify(diagnostics)).toBe(
                false,
              );
              expect(existsSync(retentionPath("data-manager")), JSON.stringify(diagnostics)).toBe(
                false,
              );
              expect(
                await fixture.sql`SELECT id FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`,
              ).toEqual([]);
            } finally {
              clock.mockRestore();
            }
          }
        });
        const next = await job();
        await owned(next, async () =>
          expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
        );
      },
      60000,
    );
    it.each([
      [false, false],
      [true, false],
      [true, true],
    ])(
      "constructs actual durable nonempty unused runtime evidence and commits one immutable original owner final (dispatch=%s mirror-loss=%s)",
      async (dispatch, mirrorLoss) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                    value: "synthetic-unused-final-credential",
                  },
                ],
              },
            }),
            maintenance = await import("../configuration-maintenance"),
            prepared = await maintenance.prepareConfigurationMaintenance(candidate),
            decision = await maintenance.prepareConfigurationMaintenanceAbandon(candidate);
          await maintenance.decideConfigurationMaintenance(decision);
          const authority = restoreAdmittedControlExecution(installation, prepared.prepare),
            runtime = await import("../../../../ops-agent/src/configuration-maintenance-runtime"),
            store = await import("../../../../ops-agent/src/configuration-maintenance-store"),
            before = store.readOwnedConfigurationMaintenance(authority),
            inspection = await runtime.inspectFrozenMaintenanceRuntime(
              host.runtime,
              authority,
              new AbortController().signal,
            ),
            final = store.finalizeOwnedMaintenanceState(authority, inspection),
            after = store.readOwnedConfigurationMaintenance(authority);
          expect(after.final).toMatchObject({
            ownerFinal: { payload: { outcome: "unused", ownerSequence: before.sequence + 1 } },
            evidence: {
              outcome: "unused",
              children: [],
              generation: { state: "not_committed" },
              runtime: { mode: "unused" },
            },
          });
          expect(after.receipt.state).toBe("settling");
          expect(after.receipt.dmFence?.state).toBe("prepared");
          expect(after.inspection!.payload.observations[0]!.detail).toBe(
            JSON.stringify({ currentRevisionId: host.initial.revisionId }),
          );
          expect(store.restoreOwnedMaintenanceFinal(authority)).toEqual(final);
          store.publishOwnedConfigurationFenceSettlement(authority, prepared.binding.maintenanceId);
          const cellPath = join(
              host.infraDir,
              "data/.admin-target-control/executions/ops-agent",
              `${prepared.prepare.operationKey}.configuration-settlement.json`,
            ),
            bytes = readFileSync(cellPath),
            packet = JSON.parse(bytes.toString()),
            core = await import("@openmapx/core/build-artifacts"),
            records = await import(
              "../../../../../packages/core/src/build-artifacts/configuration-fence-settlement-records"
            );
          expect(bytes.length).toBe(16384);
          expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThanOrEqual(16384);
          const committed = core.verifyControl(
            installation.publicKey,
            records.configurationSettlementDomains.reference,
            packet,
            records.configurationCommittedSettlementSchema,
          );
          expect(committed).toMatchObject({
            phase: "committed",
            final: { outcome: "unused" },
            evidence: { outcome: "unused" },
          });
          expect(committed.evidenceDigest).toBe(after.final!.evidenceDigest);
          store.publishOwnedConfigurationFenceSettlement(authority, prepared.binding.maintenanceId);
          expect(readFileSync(cellPath)).toEqual(bytes);
          const control = store.prepareConfigurationFenceSettlementControl(
              authority,
              prepared.binding.maintenanceId,
            ),
            delegated = store.delegateConfigurationFenceSettlementControl(control),
            repeated = store.delegateConfigurationFenceSettlementControl(control);
          expect(delegated).toMatchObject({
            dispatch: "fresh",
            envelope: {
              payload: {
                bindingVersion: 3,
                originalParentForwardDeadlineAt: prepared.prepare.deadlineAt,
              },
            },
          });
          expect(
            delegated.envelope.payload.controlDeadlineAt -
              delegated.envelope.payload.controlStartedAt,
          ).toBe(60000);
          expect(repeated).toMatchObject({
            dispatch: "observe-only",
            envelope: delegated.envelope,
            assertion: delegated.assertion,
          });
          const privateBinding = JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "control-private/ops-agent/observations",
                `${prepared.prepare.operationKey}.configuration-settlement-binding.json`,
              ),
              "utf8",
            ),
          );
          expect(
            core.verifyControl(
              installation.publicKey,
              records.configurationSettlementDomains.binding,
              privateBinding,
              records.configurationSettlementControlEnvelopeSchema,
            ),
          ).toEqual(delegated.envelope.payload);
          expect(() =>
            core.inspectArtifactDelegation({
              dataRoot: join(host.infraDir, "data"),
              installation,
              assertion: delegated.assertion,
            }),
          ).toThrow();
          if (dispatch) {
            if (delegated.dispatch !== "fresh") throw Error("Original fresh ticket required");
            const { configurationDataManagerTransport } = await import(
                "../../../../ops-agent/src/configuration-hardlinks-runtime"
              ),
              [beforeSql] =
                await fixture.sql`SELECT ownership_version FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`,
              nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs"))
                .renameSync;
            let faulted = false;
            const fault = mirrorLoss
              ? vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
                  if (
                    !faulted &&
                    basename(String(target)) === `${prepared.binding.maintenanceId}.json`
                  ) {
                    const value = JSON.parse(readFileSync(source, "utf8")).payload;
                    if (
                      value?.metadata?.guardState === "settled" &&
                      value.metadata.settlementControl?.settlementId ===
                        delegated.envelope.payload.settlementId
                    ) {
                      faulted = true;
                      throw Error(
                        "Injected native mirror publication failure after actual SQL COMMIT",
                      );
                    }
                  }
                  return nativeRename(source, target);
                })
              : undefined;
            let settled: unknown;
            try {
              if (mirrorLoss)
                await expect(
                  store.dispatchConfigurationFenceSettlementControl(
                    delegated.ticket,
                    configurationDataManagerTransport(),
                  ),
                ).rejects.toBeInstanceOf(Error);
              else
                settled = await store.dispatchConfigurationFenceSettlementControl(
                  delegated.ticket,
                  configurationDataManagerTransport(),
                );
            } finally {
              fault?.mockRestore();
            }
            const [sqlRow] =
                await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`,
              sqlMetadata = sqlRow!.metadata.configurationMaintenance,
              tuple = sqlMetadata.settlementControl.tuple,
              controlKey = delegated.envelope.payload.execution.operationKey,
              privateDirectory = join(host.infraDir, "control-private/data-manager/observations"),
              terminalPath = join(
                privateDirectory,
                `${controlKey}.configuration-settlement-terminal.json`,
              ),
              mirrorPath = join(
                host.infraDir,
                "control-private/data-manager/configuration-maintenance",
                `${prepared.binding.maintenanceId}.json`,
              );
            expect(sqlRow!.ownership_version).toBe(beforeSql!.ownership_version + 1);
            expect(sqlMetadata.receipt).toEqual(prepared.dmFence);
            expect(tuple).toMatchObject({
              execution: delegated.envelope.payload.execution,
              result: {
                state: "settled",
                fenceId: prepared.dmFence!.fenceId,
                sequence: prepared.dmFence!.sequence + 1,
              },
            });
            const session = sqlMetadata.settlementControl.sqlSession,
              [backend] =
                await fixture.sql`SELECT backend_start::text AS backend_start,application_name FROM pg_stat_activity WHERE pid=${session.pid}`;
            expect(backend).toMatchObject({
              backend_start: session.backendStart,
              application_name: `omx-config-settle:${session.sessionNonce}`,
            });
            expect(session.sessionNonce).toBe(delegated.envelope.payload.execution.executionId);
            if (mirrorLoss) {
              expect(faulted).toBe(true);
              expect(JSON.parse(readFileSync(mirrorPath, "utf8")).payload.metadata.guardState).toBe(
                "settling",
              );
              expect(JSON.parse(readFileSync(terminalPath, "utf8"))).toBeNull();
              await expect(dm!.receiver.admitLocal({ kind: "download-fonts" })).rejects.toThrow(
                "configuration_maintenance_busy",
              );
              // ACTUAL API -> agent-produced inspection witness -> DM GET. No
              // second settlement POST/ticket, UPDATE or runtime attestation.
              const nativeFetch = globalThis.fetch,
                frames: { path: string; status: number }[] = [],
                observer = vi.spyOn(globalThis, "fetch").mockImplementation(async (...args) => {
                  const response = await nativeFetch(...args);
                  frames.push({ path: new URL(String(args[0])).pathname, status: response.status });
                  return response;
                });
              let inspected: unknown;
              try {
                inspected = await maintenance.inspectConfigurationMaintenance(prepared.binding);
              } finally {
                observer.mockRestore();
              }
              expect(
                JSON.parse(readFileSync(terminalPath, "utf8")),
                JSON.stringify({ frames, inspected }),
              ).not.toBeNull();
            }
            const terminal = JSON.parse(readFileSync(terminalPath, "utf8")),
              mirror = JSON.parse(readFileSync(mirrorPath, "utf8")).payload,
              admission = JSON.parse(
                readFileSync(
                  join(privateDirectory, `${controlKey}.configuration-settlement-admission.json`),
                  "utf8",
                ),
              ),
              effect = JSON.parse(
                readFileSync(
                  join(privateDirectory, `${controlKey}.configuration-settlement-effect.json`),
                  "utf8",
                ),
              );
            expect(terminal.payload.tuple).toEqual(tuple);
            expect(effect.payload).toMatchObject({
              phase: "committed",
              terminal: tuple,
              sqlSession: session,
            });
            expect(terminal.payload).toHaveProperty("effectSource");
            const originalEffect = {
              payload: { ...terminal.payload.effectSource.fields, terminal: tuple },
              signature: terminal.payload.effectSource.signature,
            };
            expect(
              core.verifyControl(
                core.controlRolePublicKey(installation, "data-manager"),
                records.configurationSettlementDomains.effect,
                originalEffect,
                records.configurationSettlementEffectSchema,
              ),
            ).toEqual(effect.payload);
            expect(terminal.payload.effectSettlementDigest).toBe(
              records.settlementRecordDigest(
                records.configurationSettlementDomains.effect,
                effect.payload,
              ),
            );
            expect(mirror.metadata).toEqual(sqlMetadata);
            expect(admission.payload.controlEnvelope).toEqual(delegated.envelope);
            expect(terminal.payload).toHaveProperty("admissionSource");
            expect(terminal.payload.admissionSource).toEqual({
              boundAt: admission.payload.boundAt,
              signature: admission.signature,
            });
            if (!mirrorLoss) expect(settled).toEqual(tuple.result);
            expect(store.observeConfigurationFenceSettlementControl(control)).toEqual(tuple.result);
            const copied = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/ops-agent/observations",
                    `${prepared.prepare.operationKey}.configuration-settlement-ack.json`,
                  ),
                  "utf8",
                ),
              ),
              sharedAck = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "data/.admin-target-control/executions/ops-agent",
                    `${prepared.prepare.operationKey}.configuration-settlement-ack.json`,
                  ),
                  "utf8",
                ),
              );
            expect(copied.terminal).toEqual(terminal);
            expect(copied.ack).toEqual(sharedAck);
            expect(sharedAck.payload).toMatchObject({
              terminalDigest: tuple.terminalDigest,
              terminalAt: tuple.terminalAt,
            });
            expect(store.observeConfigurationFenceSettlementControl(control)).toEqual(tuple.result);
            const dmAckPath = join(
              privateDirectory,
              `${controlKey}.configuration-settlement-ack.json`,
            );
            expect(JSON.parse(readFileSync(dmAckPath, "utf8"))).toBeNull();
            await maintenance.inspectConfigurationMaintenance(prepared.binding);
            expect(JSON.parse(readFileSync(dmAckPath, "utf8"))).toEqual(sharedAck);
            core.assertConfigurationMaintenanceRootClosure(authority);
            if (!mirrorLoss) {
              const lease = core.restoreArtifactTargetLeaseForSettlement(authority),
                leasePath = join(host.infraDir, "data/.admin-target-control/leases", lease.leaseId),
                directoryInode = statSync(leasePath).ino,
                certificate = JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8"))
                  .payload.certificate,
                admissionPath = join(
                  host.infraDir,
                  "control-private/ops-agent/executions",
                  `${prepared.prepare.operationKey}.json`,
                ),
                originalAdmission = readFileSync(admissionPath);
              core.closeArtifactTargetLeaseHandle(lease);
              expect(await store.releaseOwnedConfigurationMaintenanceRoot(authority)).toMatchObject(
                { state: "settled", dmFence: { state: "settled" } },
              );
              core.verifyRetainedArtifactTargetRootRelease(authority);
              expect(readFileSync(admissionPath)).toEqual(originalAdmission);
              expect(statSync(leasePath).ino).toBe(directoryInode);
              expect(
                JSON.parse(readFileSync(join(leasePath, "owner.json"), "utf8")).payload.certificate,
              ).toEqual(certificate);
              expect(
                existsSync(join(host.infraDir, "data/.admin-target-control/locks/motis")),
              ).toBe(false);
            }
            const [afterSql] =
              await fixture.sql`SELECT metadata,ownership_version,xmin::text AS xmin FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`;
            expect(afterSql).toEqual(sqlRow);
            console.info(
              JSON.stringify({
                proof: "actual-unused-logical-settlement",
                mirrorLoss,
                session,
                terminalAt: tuple.terminalAt,
                commitmentBytes: Buffer.byteLength(JSON.stringify(packet)),
                boundControlBytes: Buffer.byteLength(
                  readFileSync(
                    join(
                      host.infraDir,
                      "data/.admin-target-control/executions/ops-agent",
                      `${prepared.prepare.operationKey}.configuration-settlement-control.json`,
                    ),
                  ),
                ),
              }),
            );
            await expect(
              store.dispatchConfigurationFenceSettlementControl(
                delegated.ticket,
                configurationDataManagerTransport(),
              ),
            ).rejects.toThrow("Original unconsumed settlement dispatch ticket required");
          }
          expect(() => store.finalizeOwnedMaintenanceState(authority, {} as never)).toThrow(
            "Actual maintenance runtime inspection required",
          );
          expect(
            host.calls.some(
              (args) => args.includes("up") || args.includes("pull") || args.includes("restart"),
            ),
          ).toBe(false);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(!(dispatch && !mirrorLoss));
        });
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
            const executionsPath = join(host.infraDir, "control-private/ops-agent/executions"),
              familiesPath = join(host.infraDir, "control-private/ops-agent/retention-locations"),
              executionsBefore = readdirSync(executionsPath).sort(),
              familiesBefore = readdirSync(familiesPath).sort(),
              rootBytes = readFileSync(
                join(executionsPath, `${prepared.prepare.operationKey}.json`),
              ),
              [guardBefore] =
                await fixture.sql`SELECT xmin::text AS version FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`;
            const core = await import("@openmapx/core/build-artifacts"),
              originalAuthority = restoreAdmittedControlExecution(installation, prepared.prepare),
              lease = core.restoreArtifactTargetLeaseForSettlement(originalAuthority),
              ownerPath = join(
                host.infraDir,
                "data/.admin-target-control/leases",
                lease.leaseId,
                "owner.json",
              ),
              ownerBytes = readFileSync(ownerPath),
              ownerInode = statSync(ownerPath).ino;
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
              projection = (await import("../admin-job-ops")).readProjection(ctx.checkpointResult),
              [control] = Object.values(projection.operations).filter(
                (operation) => operation.kind === "configurationMaintenance.decide",
              );
            expect(control).toMatchObject({
              operation: decision,
              terminal: true,
              receiptDelivery: { state: "confirmed" },
            });
            expect(
              store.readOwnedConfigurationMaintenance(authority).apiControls.decide,
            ).toMatchObject({
              execution: { operationKey: control!.operationKey },
              canonicalDigest: control!.receiptDelivery!.terminalDigest,
              receiptDelivery: { terminalCopyId: control!.receiptDelivery!.terminalCopyId },
            });
            const actualControl =
                store.readOwnedConfigurationMaintenance(authority).apiControls.decide!,
              { verifyApiJobParentExecution } = await import("@openmapx/core/ops"),
              actualParent = verifyApiJobParentExecution(
                actualControl.parentAssertion,
                host.token,
                {
                  operationKey: actualControl.execution.operationKey,
                  operationFingerprint: actualControl.execution.operationFingerprint,
                  requestedDeadlineAt: actualControl.requestedDeadlineAt,
                },
              ),
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
            expect(readdirSync(familiesPath).sort()).toEqual(familiesBefore);
            expect(
              readFileSync(join(executionsPath, `${prepared.prepare.operationKey}.json`)),
            ).toEqual(rootBytes);
            expect(readFileSync(ownerPath)).toEqual(ownerBytes);
            expect(statSync(ownerPath).ino).toBe(ownerInode);
            const [guardAfter] =
              await fixture.sql`SELECT xmin::text AS version FROM data_manager.jobs WHERE id=${prepared.dmFence!.fenceId}::uuid`;
            expect(guardAfter?.version).toBe(guardBefore?.version);
            // Lose only the secondary jobs journal entry after the actual private
            // original-owner CAS and authenticated API copy/ACK. Reopen the real
            // assembly: lookup must recover that exact immutable source, not admit
            // another request/root or infer success from the API's cached result.
            await app.close();
            closeControlInstallation(installation);
            const journalPath = join(host.infraDir, "data/ops-agent/jobs-v1.json"),
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
                "control-private/ops-agent/configuration-maintenance",
                `${prepared.binding.maintenanceId}.json`,
              ),
              hiddenOwner = join(host.root, "temporarily-unavailable-maintenance-owner.json");
            nodeFs.renameSync(privateOwner, hiddenOwner);
            try {
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
            expect(readFileSync(ownerPath)).toEqual(ownerBytes);
            expect(statSync(ownerPath).ino).toBe(ownerInode);
            expect(readdirSync(executionsPath).sort()).toEqual(executionsBefore);
            expect(readdirSync(familiesPath).sort()).toEqual(familiesBefore);
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
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
        });
      },
      60000,
    );
    it.each([
      { issued: false, capacityNull: false },
      { issued: true, capacityNull: false },
      { issued: true, capacityNull: true },
    ])(
      "closes an original durable nonempty never-issued or receiver-refused owner automatically with issued=$issued capacity-null=$capacityNull",
      async ({ issued, capacityNull }) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
        const coordinator = {
          ...host.row,
          Id: "c".repeat(64),
          State: "running",
          ConfigImage: "example/data-manager:1",
          Labels: { ...host.row.Labels, "com.docker.compose.service": "data-manager" },
        };
        host.setRows([host.row, coordinator]);
        const ctx = await job(),
          busyId = randomUUID();
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
          const { record } = prospective.validatedConfigurationCandidateState(candidate),
            ownerPath = join(
              host.infraDir,
              "control-private/ops-agent/configuration-maintenance",
              `${record.maintenanceId}.json`,
            );
          let afterAdmission = false;
          const loseCoordinator = async () => {
            if (existsSync(ownerPath)) {
              afterAdmission = true;
              host.setRows([host.row, { ...coordinator, State: "exited" }]);
            } else host.setInventoryProcess(loseCoordinator);
          };
          if (issued)
            await fixture.sql`INSERT INTO data_manager.jobs(id,kind,status,started_at) VALUES(${busyId}::uuid,'download-fonts','running',now())`;
          else host.setInventoryProcess(loseCoordinator);
          const { prepareConfigurationMaintenance } = await import("../configuration-maintenance");
          const nativeStatfs = (await vi.importActual<typeof import("node:fs")>("node:fs"))
              .statfsSync,
            privateIdentity = statSync(join(host.infraDir, "control-private/data-manager")),
            pressure = capacityNull
              ? vi.spyOn(nodeFs, "statfsSync").mockImplementation(((
                  path: nodeFs.PathLike,
                  options?: { bigint?: boolean },
                ) => {
                  const identity = statSync(path),
                    actual = nativeStatfs(path, options as { bigint: true });
                  return identity.dev === privateIdentity.dev &&
                    identity.ino === privateIdentity.ino
                    ? {
                        ...actual,
                        bavail: typeof actual.bavail === "bigint" ? 4n : 4,
                        bsize: typeof actual.bsize === "bigint" ? 4096n : 4096,
                      }
                    : actual;
                }) as typeof nodeFs.statfsSync)
              : null;
          try {
            await expect(prepareConfigurationMaintenance(candidate)).rejects.toBeInstanceOf(Error);
          } finally {
            pressure?.mockRestore();
          }
          expect(issued || afterAdmission).toBe(true);
          const core = await import("@openmapx/core/build-artifacts"),
            owner = JSON.parse(readFileSync(ownerPath, "utf8")).payload,
            authority = core.restoreAdmittedControlExecution(installation, owner.plan.prepare),
            ownerStore = await import("../../../../ops-agent/src/configuration-maintenance-store");
          expect(owner.issuance).toBe("closed_without_guard");
          await ownerStore.closeOwnedConfigurationMaintenanceWithoutGuard(host.runtime, authority);
          const completed = ownerStore.readOwnedConfigurationMaintenance(authority);
          if (issued) {
            expect(completed.noGuard?.noGuardEvidence.kind).toBe("receiver_refused");
            if (capacityNull)
              expect(completed.noGuard?.noGuardEvidence).toMatchObject({
                capacityReceiptDigest: null,
              });
          } else
            expect(completed.noGuard).toMatchObject({
              noGuardEvidence: { kind: "never_issued" },
              issuerFreezeProof: {
                payload: {
                  publicationStates: owner.plan.reservations.map(
                    (value: {
                      phase: string;
                      ordinal: number;
                      execution: { operationKey: string };
                    }) => ({
                      phase: value.phase,
                      ordinal: value.ordinal,
                      operationKey: value.execution.operationKey,
                      grantState: "unissued",
                      intentState: "not_attempted",
                    }),
                  ),
                },
              },
            });
          core.assertConfigurationMaintenanceRootClosure(authority);
          core.verifyRetainedArtifactTargetRootRelease(authority);
          // Repeat only the original attempted producer: it must observe the same
          // failed root and deliver its durable canonical receipt, never POST again.
          await expect(prepareConfigurationMaintenance(candidate)).rejects.toBeInstanceOf(Error);
          expect(
            (
              ctx.checkpointResult?.opsProjection as {
                operations: Record<string, { receiptDelivery?: { state: string } }>;
              }
            ).operations[record.prepareOperationKey!]?.receiptDelivery?.state,
          ).toBe("confirmed");
          const location = join(
              host.infraDir,
              "control-private/ops-agent/retention-locations",
              `${core.controlDigest(owner.origin)}.json`,
            ),
            retirementClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600000);
          try {
            expect(existsSync(location)).toBe(true);
            const bundlePath = join(
                host.infraDir,
                "data/.admin-target-control/executions/ops-agent",
                `${owner.plan.prepare.operationKey}.configuration-settlement.json`,
              ),
              original = readFileSync(bundlePath),
              corrupt = Buffer.from(original);
            corrupt[12] = corrupt[12] === 120 ? 121 : 120;
            try {
              writeFileSync(bundlePath, corrupt);
              await core.reconcileControlRetention(installation, { maxFamilies: 64 });
              await dm!.reconcileRetention();
              expect(existsSync(location)).toBe(true);
            } finally {
              writeFileSync(bundlePath, original);
            }
            for (let round = 0; round < 12 && existsSync(location); round++) {
              await core.reconcileControlRetention(installation, { maxFamilies: 64 });
              await dm!.reconcileRetention();
            }
            const diagnostics = ["ops-agent", "data-manager"].map((role) => {
              const path = join(
                host.infraDir,
                "control-private",
                role,
                "retention-locations",
                `${core.controlDigest(owner.origin)}.json`,
              );
              if (!existsSync(path)) return { role, retired: true };
              const retained = JSON.parse(readFileSync(path, "utf8")),
                progress = JSON.parse(
                  readFileSync(
                    join(
                      host.infraDir,
                      "control-private",
                      role,
                      "retention-families",
                      retained.name,
                      "progress.json",
                    ),
                    "utf8",
                  ),
                );
              const shared = join(
                  host.infraDir,
                  "data/.admin-target-control/retention-families",
                  core.controlDigest(owner.origin),
                ),
                candidatePath = join(shared, `candidate-${role}.json`),
                rawCandidate = existsSync(candidatePath)
                  ? JSON.parse(readFileSync(candidatePath, "utf8"))
                  : null,
                ackPath = join(shared, "api-ack.json"),
                apiAck = existsSync(ackPath) ? JSON.parse(readFileSync(ackPath, "utf8")) : null;
              return {
                role,
                phase: progress.phase,
                lastError: progress.lastError,
                terminalAt: progress.terminalAt,
                slotState: progress.configurationSettlementSlot?.state,
                candidatePublished: Boolean(rawCandidate),
                apiAck: Boolean(apiAck),
                participants: progress.participants,
                executions: Object.values<{
                  execution?: { executor?: string };
                  known?: boolean;
                  requiresJournal?: boolean;
                  journalContained?: boolean;
                  canonicalDigest?: string;
                }>(progress.executions).map((fact) => ({
                  kind: fact.execution?.executor,
                  known: fact.known,
                  requiresJournal: fact.requiresJournal,
                  journalContained: fact.journalContained,
                  canonical: Boolean(fact.canonicalDigest),
                })),
              };
            });
            expect(existsSync(location), JSON.stringify(diagnostics)).toBe(false);
          } finally {
            retirementClock.mockRestore();
          }
          expect(dm!.preparePosts).toBe(issued ? 1 : 0);
          expect(
            await fixture.sql`SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance'`,
          ).toEqual([]);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
        }).finally(async () => {
          await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${busyId}::uuid`;
        });
      },
      60000,
    );
    it("cleans the current persister's actual durable nonempty NoGuard busy refusal after the old helper settles", async () => {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
      vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        busyId = randomUUID();
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
                    value: "synthetic-current-noguard-busy",
                  },
                ],
              },
            }),
            { record } = prospective.validatedConfigurationCandidateState(candidate);
          await prospective.stageProspectiveConfigurationMaintenance(candidate);
          expect(starts).toBe(1);
          expect(dm!.preparePosts).toBe(0);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(false);
          // A competing synthetic live row wins the ACTUAL common SQL admission
          // guard in the gap, after helper release. No worker/result is faked.
          await fixture.sql.begin(async (tx) => {
            const [lock] = await tx`SELECT pg_try_advisory_xact_lock(${0x4f4d58},${2}) AS acquired`;
            expect(lock!.acquired).toBe(true);
            await tx`INSERT INTO data_manager.jobs(id,kind,status,started_at) VALUES(${busyId}::uuid,'download-fonts','running',now())`;
          });
          const before =
            await fixture.sql`SELECT *,xmin::text AS row_version FROM data_manager.jobs WHERE id=${busyId}::uuid`;
          let failure: unknown;
          try {
            await prospective.persistAndApplyProspectiveConfiguration(candidate, {
              coordinatorMode: "ensure-running",
            });
          } catch (error) {
            failure = error;
          }
          expect(failure).toBeInstanceOf((await import("../ops-client")).ApiOpsError);
          expect(failure).toMatchObject({ errorClass: "busy" });
          const core = await import("@openmapx/core/build-artifacts"),
            records = await import(
              "../../../../../packages/core/src/build-artifacts/configuration-maintenance-owner-records"
            ),
            owner = core.verifyControl(
              installation.publicKey,
              "openmapx-configuration-maintenance-owner-v2",
              JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/ops-agent/configuration-maintenance",
                    `${record.maintenanceId}.json`,
                  ),
                  "utf8",
                ),
              ),
              records.configurationMaintenanceOwnerRecordSchema,
            ),
            authority = restoreAdmittedControlExecution(installation, owner.plan.prepare);
          expect(owner).toMatchObject({
            issuance: "closed_without_guard",
            receipt: { state: "settled", dmFence: null, decision: null, generation: "not_started" },
          });
          core.assertConfigurationMaintenanceRootClosure(authority);
          core.verifyRetainedArtifactTargetRootRelease(authority);
          expect(
            await fixture.sql`SELECT *,xmin::text AS row_version FROM data_manager.jobs WHERE id=${busyId}::uuid`,
          ).toEqual(before);
          expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
          expect(dm!.preparePosts).toBe(1);
          expect(dm!.settlePosts).toBe(0);
          expect(starts).toBe(1);
          expect(
            host.calls.some(
              (args) =>
                args.includes("--force-recreate") ||
                args.includes("pull") ||
                args.includes("restart"),
            ),
          ).toBe(false);
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          expect(ctx.checkpointResult!._configurationCandidate).toMatchObject({
            candidateId: candidate.candidateId,
            phase: "discarded",
          });
          expect(ctx.checkpointResult!.configuration).toMatchObject({
            outcome: "not_committed",
            reason: "busy",
          });
          expect(existsSync(join(host.queue, ".candidates", `${record.operationKey}.json`))).toBe(
            false,
          );
        });
        const next = await job();
        await owned(next, async () =>
          expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
        );
      } finally {
        await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${busyId}::uuid AND kind='download-fonts'`;
      }
    }, 120000);
    it.each([false, true])(
      "publishes actual durable nonempty receiver busy refusal after full reservation with capacity-null=%s without changing the winning data job",
      async (capacityNull) => {
        dm = await ownedDataManager({
          sql: fixture.sql,
          infraDir: host.infraDir,
          serviceIds: host.loaded.map((service) => service.manifest.id),
        });
        vi.stubEnv("DATA_MANAGER_URL", dm.baseUrl);
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        const ctx = await job(),
          busyId = randomUUID();
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
                    value: "synthetic-coordinator-credential",
                  },
                ],
              },
            });
            await prospective.stageProspectiveConfigurationMaintenance(candidate);
            await fixture.sql`INSERT INTO data_manager.jobs(id,kind,status,started_at) VALUES(${busyId}::uuid,'download-fonts','running',now())`;
            const before =
              await fixture.sql`SELECT * FROM data_manager.jobs WHERE id=${busyId}::uuid`;
            const { prepareConfigurationMaintenance } = await import(
              "../configuration-maintenance"
            );
            const nativeStatfs = (await vi.importActual<typeof import("node:fs")>("node:fs"))
                .statfsSync,
              privateIdentity = statSync(join(host.infraDir, "control-private/data-manager")),
              pressure = capacityNull
                ? vi.spyOn(nodeFs, "statfsSync").mockImplementation(((
                    path: nodeFs.PathLike,
                    options?: { bigint?: boolean },
                  ) => {
                    const identity = statSync(path),
                      actual = nativeStatfs(path, options as { bigint: true });
                    return identity.dev === privateIdentity.dev &&
                      identity.ino === privateIdentity.ino
                      ? {
                          ...actual,
                          bavail: typeof actual.bavail === "bigint" ? 4n : 4,
                          bsize: typeof actual.bsize === "bigint" ? 4096n : 4096,
                        }
                      : actual;
                  }) as typeof nodeFs.statfsSync)
                : null;
            const nativeOpenDir = (
                await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises")
              ).opendir,
              unavailable = vi.spyOn(nodeFsPromises, "opendir").mockImplementation((async (
                path,
                options,
              ) => {
                if (String(path) === host.queue)
                  throw Error(
                    "Injected original queue temporarily unavailable for automatic refusal closure",
                  );
                return nativeOpenDir(path, options);
              }) as typeof nodeFsPromises.opendir);
            try {
              await expect(prepareConfigurationMaintenance(candidate)).rejects.toBeInstanceOf(
                Error,
              );
            } finally {
              pressure?.mockRestore();
              unavailable.mockRestore();
            }
            expect(
              await fixture.sql`SELECT * FROM data_manager.jobs WHERE id=${busyId}::uuid`,
            ).toEqual(before);
            const { record } = prospective.validatedConfigurationCandidateState(candidate),
              owner = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/ops-agent/configuration-maintenance",
                    `${record.maintenanceId}.json`,
                  ),
                  "utf8",
                ),
              ).payload,
              prepare = owner.plan.reservations.find(
                (value: { phase: string }) => value.phase === "configuration-fence",
              ),
              path = join(
                host.infraDir,
                "data/.admin-target-control/executions/data-manager",
                `${prepare.execution.operationKey}.configuration-settlement-capacity.json`,
              ),
              channel = JSON.parse(readFileSync(path, "utf8"));
            expect(statSync(path).size).toBe(8192);
            if (capacityNull) expect(channel.capacity).toBeNull();
            else expect(channel.capacity).not.toBeNull();
            expect(channel.refusal).toMatchObject({
              payload: {
                refusalReceipt: {
                  kind: "data-configuration-fence-refused",
                  reason: capacityNull ? "capacity" : "busy",
                },
                maintenanceId: record.maintenanceId,
                prepareExecution: { operationKey: prepare.execution.operationKey },
              },
            });
            const core = await import("@openmapx/core/build-artifacts"),
              records = await import(
                "../../../../../packages/core/src/build-artifacts/configuration-fence-settlement-records"
              ),
              publicKey = core.controlRolePublicKey(installation, "data-manager"),
              refusal = core.verifyControl(
                publicKey,
                records.configurationSettlementDomains.refusal,
                channel.refusal,
                records.configurationDmNoGuardRefusalSchema,
              ),
              capacity =
                channel.capacity &&
                core.verifyControl(
                  publicKey,
                  records.configurationSettlementDomains.capacity,
                  channel.capacity,
                  records.configurationSettlementCapacitySchema,
                ),
              authority = core.restoreAdmittedControlExecution(installation, owner.plan.prepare),
              lease = core.restoreArtifactTargetLeaseForSettlement(authority);
            try {
              const child = core.lookupControlChildPhaseBinding(authority, prepare)!.child,
                settlement = core.inspectArtifactTargetLeaseChildSettlement(lease, child.execution);
              expect(settlement).toMatchObject({
                outcome: "failed_without_effect",
                publication: "not_started",
              });
              expect(refusal.effectReceiptDigest).toBe(core.controlDigest(refusal.refusalReceipt));
              expect(refusal.effectSettlementDigest).toBe(
                core.controlDigest({ ...settlement, receipt: refusal.refusalReceipt }),
              );
              expect(refusal.canonicalTerminalDigest).toBe(
                core.controlDigest({ version: 1, refused: refusal.refusalReceipt }),
              );
              expect(refusal.capacityReceiptDigest).toBe(
                capacity
                  ? records.settlementRecordDigest(
                      records.configurationSettlementDomains.capacity,
                      capacity,
                    )
                  : null,
              );
              expect(() =>
                core.verifyControl(
                  publicKey,
                  records.configurationSettlementDomains.refusal,
                  { ...channel.refusal, payload: { ...refusal, candidateId: randomUUID() } },
                  records.configurationDmNoGuardRefusalSchema,
                ),
              ).toThrow();
            } finally {
              core.closeArtifactTargetLeaseHandle(lease);
            }
            expect(channel.unused).toMatchObject({
              intent: { payload: { role: "data-manager", settlementId: refusal.settlementId } },
              confirmation: {
                payload: { role: "data-manager", settlementId: refusal.settlementId },
              },
            });
            const intent = core.verifyControl(
                publicKey,
                records.configurationSettlementDomains.unusedIntent,
                channel.unused.intent,
                records.configurationUnusedCapacityIntentSchema,
              ),
              confirmation = core.verifyControl(
                publicKey,
                records.configurationSettlementDomains.unusedConfirmation,
                channel.unused.confirmation,
                records.configurationUnusedCapacityConfirmationSchema,
              ),
              location = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/data-manager/retention-locations",
                    `${core.controlDigest(refusal.origin)}.json`,
                  ),
                  "utf8",
                ),
              ),
              progress = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "control-private/data-manager/retention-families",
                    location.name,
                    "progress.json",
                  ),
                  "utf8",
                ),
              ),
              slot = progress.configurationSettlementSlot;
            expect(slot).toMatchObject({
              state: "UNUSED",
              executionDigest: null,
              controlBindingDigest: null,
              executionOrdinal: capacity?.reservedExecutionOrdinal ?? null,
              intentOrdinal: capacity?.reservedIntentOrdinal ?? null,
              unusedIntentDigest: records.settlementRecordDigest(
                records.configurationSettlementDomains.unusedIntent,
                intent,
              ),
            });
            expect(Object.keys(progress.executions)).toHaveLength(1);
            expect(intent.allocatedDescriptorDigests).toHaveLength(capacityNull ? 1 : 6);
            expect(intent.sourceProofDigest).toBe(
              records.settlementRecordDigest(
                records.configurationSettlementDomains.refusal,
                refusal,
              ),
            );
            expect(confirmation.intentDigest).toBe(slot.unusedIntentDigest);
            expect(confirmation.confirmedAt).toBe(slot.unusedConfirmedAt);
            expect(confirmation.slotStateDigest).toBe(
              core.controlDigest({
                executionOrdinal: slot.executionOrdinal,
                intentOrdinal: slot.intentOrdinal,
                recordDescriptorsDigest: slot.recordDescriptorsDigest,
                allocatedDescriptorDigests: slot.allocatedDescriptorDigests,
                state: "UNUSED",
                intentDigest: slot.unusedIntentDigest,
              }),
            );
            if (slot.executionOrdinal !== null) {
              const ticket = JSON.parse(
                readFileSync(
                  join(
                    host.infraDir,
                    "data/.admin-target-control/retention-families",
                    core.controlDigest(refusal.origin),
                    "executions",
                    `slot-${slot.executionOrdinal}.json`,
                  ),
                  "utf8",
                ),
              );
              expect(ticket.value).toMatchObject({
                state: "UNUSED",
                executionDigest: null,
                controlBindingDigest: null,
                unusedIntentDigest: slot.unusedIntentDigest,
              });
            } else
              expect(slot).toMatchObject({ intentOrdinal: null, refusalConstraint: "filesystem" });
            const verifiedRefusal = core.verifyPublishedDataConfigurationFenceRefusal(authority),
              verifiedUnused = core.verifyPublishedUnusedConfigurationCapacity(
                authority,
                verifiedRefusal,
              );
            expect(core.publishedDmUnusedCapacityState(verifiedUnused, authority)).toMatchObject({
              intentDigest: confirmation.intentDigest,
            });
            expect(() =>
              core.publishedDmNoGuardRefusalState({} as typeof verifiedRefusal, authority),
            ).toThrow();
            expect(() =>
              core.publishedDmUnusedCapacityState({} as typeof verifiedUnused, authority),
            ).toThrow();
            const observation = await import(
              "../../../../ops-agent/src/configuration-maintenance-runtime"
            );
            let scoped:
              | Parameters<typeof observation.unconsumedMaintenanceCandidateState>[0]
              | undefined;
            await observation.withUnconsumedMaintenanceCandidate(
              host.runtime,
              authority,
              (witness) => {
                scoped = witness;
                expect(
                  observation.unconsumedMaintenanceCandidateState(witness, authority)
                    .candidateRecordDigest,
                ).toBe(owner.plan.candidateRecordDigest);
              },
            );
            expect(() =>
              observation.unconsumedMaintenanceCandidateState(scoped!, authority),
            ).toThrow();
            const claimed = join(host.queue, ".claimed", `${candidate.revisionId}.json`);
            writeFileSync(
              claimed,
              prospective.validatedConfigurationCandidateState(candidate).sealed.bytes,
              { mode: 0o600 },
            );
            try {
              await expect(
                observation.withUnconsumedMaintenanceCandidate(host.runtime, authority, () => {
                  throw Error("Must not publish from a claimed candidate");
                }),
              ).rejects.toThrow("Candidate publication/claim requires retained observation");
            } finally {
              rmSync(claimed);
            }
            const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600000);
            try {
              const source = {
                  directory: host.queue,
                  token: host.token,
                  ownerUid: statSync(host.queue).uid,
                  ownerGid: statSync(host.queue).gid,
                },
                readers = await import("../../../../ops-agent/src/configuration-candidate-source");
              await expect(
                readers.readConfigurationCandidate(source, candidate.candidateId),
              ).rejects.toThrow();
              expect(
                (await readers.readRetainedConfigurationCandidate(source, candidate.candidateId))
                  .snapshot.revisionId,
              ).toBe(candidate.revisionId);
              await observation.withUnconsumedMaintenanceCandidate(
                host.runtime,
                authority,
                (witness) => {
                  expect(
                    observation.unconsumedMaintenanceCandidateState(witness, authority)
                      .candidateRecordDigest,
                  ).toBe(owner.plan.candidateRecordDigest);
                },
              );
            } finally {
              clock.mockRestore();
            }
            const ownerStore = await import(
                "../../../../ops-agent/src/configuration-maintenance-store"
              ),
              bundlePath = join(
                host.infraDir,
                "data/.admin-target-control/executions/ops-agent",
                `${owner.plan.prepare.operationKey}.configuration-settlement.json`,
              );
            let originalBundle: Buffer | undefined;
            if (!capacityNull) {
              const nativeRename = (await vi.importActual<typeof import("node:fs")>("node:fs"))
                .renameSync;
              let faulted = false;
              const fault = vi.spyOn(nodeFs, "renameSync").mockImplementation((source, target) => {
                nativeRename(source, target);
                if (
                  !faulted &&
                  String(target).endsWith(
                    `${owner.plan.prepare.operationKey}.configuration-settlement.json`,
                  )
                ) {
                  faulted = true;
                  throw Error(
                    "Injected filesystem failure after bundle publication before compact link",
                  );
                }
              });
              try {
                await expect(
                  ownerStore.closeOwnedConfigurationMaintenanceWithoutGuard(
                    host.runtime,
                    authority,
                  ),
                ).rejects.toThrow("Injected filesystem failure");
              } finally {
                fault.mockRestore();
              }
              expect(faulted).toBe(true);
              originalBundle = readFileSync(bundlePath);
              expect(() => core.assertConfigurationMaintenanceRootClosure(authority)).toThrow();
              await expect(
                core.bindControlChildPhase(authority, owner.plan.reservations[0]),
              ).rejects.toThrow();
            }
            const recoveryClock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3600000),
              reopened = core.openControlInstallation({
                infraDir: host.infraDir,
                role: "ops-agent",
                serviceIds: host.loaded.map((value) => value.manifest.id),
              });
            try {
              await ownerStore.closeOwnedConfigurationMaintenanceWithoutGuard(
                host.runtime,
                core.restoreAdmittedControlExecution(reopened, owner.plan.prepare),
              );
            } finally {
              core.closeControlInstallation(reopened);
              recoveryClock.mockRestore();
            }
            if (originalBundle) expect(readFileSync(bundlePath)).toEqual(originalBundle);
            const controlPath = join(
                host.infraDir,
                "data/.admin-target-control/executions/ops-agent",
                `${owner.plan.prepare.operationKey}.configuration-settlement-control.json`,
              ),
              closedBundle = JSON.parse(readFileSync(bundlePath, "utf8")),
              closedControl = JSON.parse(readFileSync(controlPath, "utf8"));
            expect(closedBundle.payload).toMatchObject({
              phase: "unused",
              closure: { payload: { noGuardEvidence: { kind: "receiver_refused" } } },
            });
            expect(closedControl.payload).toMatchObject({
              binding: null,
              unused: {
                bundleDigest: records.settlementRecordDigest(
                  records.configurationSettlementDomains.bundle,
                  closedBundle.payload,
                ),
              },
            });
            expect(() => core.assertConfigurationMaintenanceRootClosure(authority)).not.toThrow();
            const closedBytes = [readFileSync(bundlePath), readFileSync(controlPath)];
            for (const [index, target] of [bundlePath, controlPath].entries()) {
              const original = closedBytes[index]!,
                tampered = Buffer.from(original);
              tampered[12] = tampered[12] === 120 ? 121 : 120;
              try {
                writeFileSync(target, tampered);
                expect(() => core.assertConfigurationMaintenanceRootClosure(authority)).toThrow();
              } finally {
                writeFileSync(target, original);
              }
              const missing = `${target}.temporarily-missing`;
              try {
                nodeFs.renameSync(target, missing);
                expect(() => core.assertConfigurationMaintenanceRootClosure(authority)).toThrow();
              } finally {
                nodeFs.renameSync(missing, target);
              }
            }
            await ownerStore.closeOwnedConfigurationMaintenanceWithoutGuard(
              host.runtime,
              authority,
            );
            expect([readFileSync(bundlePath), readFileSync(controlPath)]).toEqual(closedBytes);
            await expect(
              core.bindControlChildPhase(authority, owner.plan.reservations[0]),
            ).rejects.toThrow();
            const release = core.restoreArtifactTargetLeaseForSettlement(authority);
            try {
              await core.settleArtifactTargetLeaseChild(
                release,
                core.verifyControlEffectSettlement(installation, owner.plan.prepare),
              );
              await core.releaseArtifactTargetLease(release);
              core.verifyRetainedArtifactTargetRootRelease(authority);
            } finally {
              core.closeArtifactTargetLeaseHandle(release);
            }
            const journalPath = join(host.infraDir, "data/ops-agent/jobs-v1.json"),
              originalJournal = readFileSync(journalPath),
              maintenance = await import("../configuration-maintenance");
            const inspectionAt = Date.now() + 3600000;
            vi.useFakeTimers({ toFake: ["Date"] });
            vi.setSystemTime(inspectionAt);
            try {
              expect(
                await maintenance.inspectConfigurationMaintenance({
                  maintenanceId: record.maintenanceId!,
                  candidateId: candidate.candidateId,
                }),
              ).toMatchObject({ state: "settled", dmFence: null, generation: "not_started" });
              const nativeFs =
                  await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises"),
                candidatePath = join(host.queue, ".candidates", `${record.operationKey}.json`);
              let unlinked = false;
              vi.mocked(nodeFsPromises.unlink).mockImplementation(async (path) => {
                await nativeFs.unlink(path);
                if (String(path) === candidatePath && !unlinked) {
                  unlinked = true;
                  throw Error("Synthetic external unlink acknowledgement lost");
                }
              });
              try {
                await expect(
                  prospective.discardNeverPreparedProspectiveConfiguration(candidate),
                ).rejects.toThrow("Synthetic external unlink acknowledgement lost");
              } finally {
                vi.mocked(nodeFsPromises.unlink).mockImplementation(nativeFs.unlink);
              }
              expect(unlinked).toBe(true);
              expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
              expect(ctx.checkpointResult?._configurationCandidate).toMatchObject({
                candidateId: candidate.candidateId,
                phase: "discarding_without_guard",
              });
              await prospective.discardNeverPreparedProspectiveConfiguration(candidate);
              expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
              expect(ctx.checkpointResult?._configurationCandidate).toMatchObject({
                candidateId: candidate.candidateId,
                phase: "discarded",
              });
            } finally {
              vi.useRealTimers();
            }
            const delivered = (
              ctx.checkpointResult?.opsProjection as {
                operations: Record<
                  string,
                  { errorClass?: string; receiptDelivery?: { state: string } }
                >;
              }
            ).operations[record.prepareOperationKey!];
            expect(delivered).toMatchObject({
              errorClass: "recovery_required",
              receiptDelivery: { state: "confirmed" },
            });
            expect(readFileSync(journalPath)).toEqual(originalJournal);
            process.stdout.write(
              `${JSON.stringify({
                proof: "actual-signed-sender-noguard-two-cells-released",
                capacityNull,
                bundleBytes: Buffer.byteLength(JSON.stringify(closedBundle)),
                bundleReserved: statSync(bundlePath).size,
                controlBytes: Buffer.byteLength(JSON.stringify(closedControl)),
                controlReserved: statSync(controlPath).size,
              })}\n`,
            );
            process.stdout.write(
              `${JSON.stringify({ proof: "actual-dm-busy-capacity-unused", encodedBytes: Buffer.byteLength(JSON.stringify(channel)), reservedBytes: statSync(path).size })}\n`,
            );
            expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
            expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
              host.initial.revisionId,
            );
            expect(
              await fixture.sql`SELECT id FROM data_manager.jobs WHERE kind='configuration-maintenance'`,
            ).toEqual([]);
            expect(dm!.preparePosts).toBe(1);
          });
          const next = await job();
          await owned(next, async () => {
            expect(
              (
                await fixture.db
                  .select({ result: schema.adminJob.result })
                  .from(schema.adminJob)
                  .where(eq(schema.adminJob.id, ctx.jobId))
              )[0]?.result,
            ).toMatchObject({ _configurationCandidate: { phase: "discarded" } });
          });
        } finally {
          await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${busyId}::uuid`;
        }
      },
      60000,
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
        const ctx = await job(),
          { prepareServiceGeneration } = await import("../service-preparation");
        if (running) {
          const result = await prepareServiceGeneration(ctx, "render-only", {
            coordinatorMode: "require-running",
          });
          expect(result).toMatchObject({
            coordinatorMode: "require-running",
            hardlinks: { applied: true, entries: 1, linked: 1 },
          });
        } else {
          await expect(
            prepareServiceGeneration(ctx, "render-only", { coordinatorMode: "require-running" }),
          ).rejects.toThrow();
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
            host.initial.revisionId,
          );
          expect(await fixture.db.select().from(schema.serviceConfig)).toEqual([]);
          expect(readdirSync(join(host.queue, ".candidates"))).toEqual([]);
        }
        expect(
          host.calls.some(
            (args) => args.includes("up") || args.includes("restart") || args.includes("pull"),
          ),
        ).toBe(false);
      },
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
              ctx.checkpointResult?.opsProjection as {
                operations: Record<string, { operationKey: string }>;
              }
            ).operations,
          )[0]!;
          const execution = JSON.parse(
            readFileSync(
              join(
                host.infraDir,
                "control-private/ops-agent/executions",
                `${operation.operationKey}.json`,
              ),
              "utf8",
            ),
          ).payload.execution;
          const authority = restoreAdmittedControlExecution(installation, execution),
            bound = lookupControlChildPhaseBinding(authority, { phase: "hardlinks", ordinal: 0 });
          let witness: unknown = "no-binding";
          if (bound) {
            const child = await dm!.store.lookup(bound.child.execution.operationKey);
            try {
              verifyDataControlTerminalWitness(installation, bound.child.execution, child?.status);
              witness = "verified";
            } catch (failure) {
              witness = String(failure);
            }
          }
          const attempt = lookupControlChildPhaseAttempt(authority, {
            phase: "hardlinks",
            ordinal: 0,
          });
          const files = attempt?.leaseId
            ? readdirSync(join(host.infraDir, "data/.admin-target-control/leases", attempt.leaseId))
            : [];
          throw Error(
            `${String(error)}; witness=${String(witness)}; lease files=${JSON.stringify(files)}; DM replies: ${JSON.stringify(await dm?.diagnostics())}`,
          );
        });
        expect(result).toMatchObject({ applied: true, entries: 1, linked: 1, via: "data-manager" });
        expect(dm.posts).toBe(1);
        const destination = join(host.infraDir, plan[0].target, "fixture.pbf");
        expect(statSync(destination).ino).toBe(statSync(join(source, "fixture.pbf")).ino);
        expect(host.calls.some((args) => args.includes("up") || args.includes("restart"))).toBe(
          false,
        );
        expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks/motis"))).toBe(
          false,
        );
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
        vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", dm.token);
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
                host.queue,
                ".candidates",
                `${prospective.validatedConfigurationCandidateState(candidate).record.operationKey}.json`,
              ),
            ),
          ).toBe(true);
          expect(
            existsSync(join(host.infraDir, "data/.admin-target-control/locks/data-manager")),
          ).toBe(true);
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
          receiptDirectory = join(host.infraDir, "data/ops-agent/lifecycle"),
          recreated = ["recreate", "crash-recreate", "missing-receipt"].includes(mode),
          crash =
            "fs.writeFileSync(" +
            JSON.stringify(join(host.root, "cli-killed")) +
            ',String(process.ppid));process.kill(process.ppid,"SIGKILL");process.exit(0);';
        mkdirSync(bin);
        writeFileSync(
          join(bin, "docker"),
          `#!${process.execPath}\nconst fs=require("node:fs"),args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(trace)},JSON.stringify(args)+"\\n");
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
          DATA_MANAGER_AUTH_TOKEN: "d".repeat(32),
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
          const entry = Object.values(readProjection(ctx.checkpointResult).operations)[0];
          expect(entry?.operationId).toBeTypeOf("string");
          await createApiOpsClient().cancel(entry!.operationId!, {
            signal: AbortSignal.timeout(15000),
          });
        }
        await running;
        expect(failure).toBeDefined();
        const [entry] = Object.values(readProjection(ctx.checkpointResult).operations),
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
        expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks/motis"))).toBe(
          true,
        );
        expect(() => core.verifyRetainedArtifactTargetRootRelease(root)).toThrow();
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
          `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+"\\n");\n`,
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
          DATA_MANAGER_AUTH_TOKEN: "d".repeat(32),
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
        expect(
          calls.map((args) => args.slice(args.indexOf("--project-directory") + 2)),
        ).toHaveLength(2);
        expect(calls[0]?.slice(-2)).toEqual(["pull", "motis"]);
        expect(calls[1]?.slice(-4)).toEqual(["up", "-d", "--force-recreate", "motis"]);
        if (!competing) {
          const directory = join(host.infraDir, "data/ops-agent/lifecycle"),
            [name] = readdirSync(directory);
          expect(name).toBeDefined();
          const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 96 * 3600000);
          try {
            let retired = 0;
            for (let i = 0; i < 12 && existsSync(join(directory, name!)); i++)
              retired += (await reconcileControlRetention(installation, { maxFamilies: 1 }))
                .retired;
            expect(retired).toBeGreaterThan(0);
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
        `#!${process.execPath}\nrequire("node:fs").appendFileSync(${JSON.stringify(trace)},JSON.stringify(process.argv.slice(2))+"\\n");\n`,
        { mode: 0o700 },
      );
      for (const [key, value] of Object.entries({
        PATH: `${bin}:${process.env.PATH}`,
        OPENMAPX_ROOT_DIR: host.root,
        OPENMAPX_RELEASE: "local",
        DOMAIN: "example.test",
        POSTGRES_PASSWORD: "p".repeat(24),
        BETTER_AUTH_SECRET: "a".repeat(32),
        DATA_MANAGER_AUTH_TOKEN: dm.token,
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
      expect(calls).toHaveLength(2);
      expect(calls[0]?.slice(-2)).toEqual(["pull", "motis"]);
      expect(calls[1]?.slice(-4)).toEqual(["up", "-d", "--force-recreate", "motis"]);
      expect(dm.posts).toBe(1);
      const [entry] = Object.values(readProjection(ctx.checkpointResult).operations),
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
      expect(existsSync(join(host.infraDir, ".trusted-config-writer"))).toBe(false);
      for (const id of ["data-manager", "motis"])
        expect(existsSync(join(host.infraDir, "data/.admin-target-control/locks", id))).toBe(false);
    }, 60000);
  },
);
