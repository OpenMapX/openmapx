import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { maintenanceRecordSchema } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { heldTargets } from "../../../../../packages/core/src/build-artifacts/__fixtures__/held-targets";
import { ownedDataManager } from "../../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../../ops-agent/src/__fixtures__/owned-service-host";
import { openOpsJobJournal } from "../../../../ops-agent/src/journal";
import { readMaintenance } from "../../../../ops-agent/src/maintenance";
import { buildOpsAgentServer } from "../../../../ops-agent/src/server";
import * as schema from "../../db/schema";
import { createConfigurationPostgresFixture } from "../../test/configuration-postgres-fixture";
import { dataManagerTokenFile } from "../../test/data-manager-token";
import type { JobContext } from "../job-runner";

type Fixture = Awaited<ReturnType<typeof createConfigurationPostgresFixture>>;
const state = vi.hoisted(() => ({
  fixture: null as unknown as Fixture,
  services: [] as services.LoadedService[],
}));
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

// The API's configuration maintenance against the production agent server and
// data-manager's fence store: prepare, save the rows, apply every step at the
// agent, settle. The agent's one record per maintenance is what is checked.
describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "configuration maintenance protocol / production agent / PostgreSQL",
  () => {
    let fixture: Fixture;
    let host: Awaited<ReturnType<typeof ownedServiceHost>>;
    let app: ReturnType<typeof buildOpsAgentServer>;
    let installation: ReturnType<typeof openControlInstallation>;
    let dm: Awaited<ReturnType<typeof ownedDataManager>> | undefined;
    let journal: Awaited<ReturnType<typeof openOpsJobJournal>>;
    beforeEach(async () => {
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
      // A coordinator and one hardlink, so a maintenance has a generation, a
      // hardlinks and a recreate step.
      host = await ownedServiceHost({ schemas, withHardlinks: true });
      const source = join(host.infraDir, "data/source-osm");
      mkdirSync(source, { recursive: true });
      writeFileSync(join(source, "fixture.pbf"), "public-osm-fixture");
      state.services = host.loaded;
      installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      journal = await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json"));
      const { openLeaseStore, leaseStoreDirectory } = await import(
        "@openmapx/core/build-artifacts"
      );
      app = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal,
        controlInstallation: installation,
        leaseStore: openLeaseStore({
          directory: leaseStoreDirectory(host.infraDir),
          purpose: "test agent",
        }),
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
    /** A queued job, or an immediate one: the API ran it for an HTTP request and
     * keeps only its intent's digest. */
    async function job(options: { immediate?: boolean } = {}): Promise<JobContext> {
      const jobId = randomUUID(),
        execution = { owner: randomUUID(), version: 1 },
        protocol = {
          execution,
          ...(options.immediate
            ? { immediate: { actorId: jobId, intentDigest: "0".repeat(64) } }
            : {}),
        };
      await fixture.db.insert(schema.adminJob).values({
        id: jobId,
        type: "service.apply",
        payload: {},
        status: "running",
        protocol,
      });
      const ctx: JobContext = {
        jobId,
        jobType: "service.apply",
        execution,
        payload: {},
        signal: new AbortController().signal,
        checkpointResult: {},
        protocol,
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
            const { replaceJobCheckpoint } = await import("../admin-job-state");
            const [saved] = await fixture.db
              .update(schema.adminJob)
              .set(replaceJobCheckpoint(result))
              .where(eq(schema.adminJob.id, jobId))
              .returning({ protocol: schema.adminJob.protocol });
            ctx.checkpointResult = result;
            ctx.protocol = saved!.protocol as JobContext["protocol"];
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
    /** A running data-manager the maintenance replaces, and the container that replaces it. */
    async function coordinator(options: { loseSettleResponseOnce?: boolean } = {}) {
      dm = await ownedDataManager({
        sql: fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
        ...options,
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
      return dmRow;
    }
    function credentialCandidate(ctx: JobContext, value: string) {
      return prospective.prepareProspectiveConfiguration({
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
              value,
            },
          ],
        },
      });
    }
    /** The job's agent operations of one kind. */
    function operations(ctx: JobContext, kind: string) {
      const recorded = (
        ctx.protocol?.operations as {
          operations?: Record<string, { kind: string; operation?: unknown; result?: unknown }>;
        }
      )?.operations;
      return Object.values(recorded ?? {}).filter((operation) => operation.kind === kind);
    }
    /** The record of the maintenance the job prepared, read from the agent's state. */
    function agentRecord(ctx: JobContext) {
      const maintenanceId = (
        operations(ctx, "configurationMaintenance.prepare")[0]?.operation as
          | { maintenanceId?: string }
          | undefined
      )?.maintenanceId;
      return readMaintenance(installation, String(maintenanceId)).record;
    }
    /** After a recreate the replacing container runs the new generation. */
    function replaceOnRecreate(
      dmRow: Awaited<ReturnType<typeof coordinator>>,
      revisionId: () => string,
      before: () => Promise<void> = async () => {},
    ) {
      host.setCreatingProcess(async () => {
        await before();
        const compose = services.configurationGenerationComposeFile(host.infraDir, revisionId());
        host.setRows([
          host.row,
          {
            ...dmRow,
            Id: "d".repeat(64),
            Labels: {
              ...dmRow.Labels,
              "com.docker.compose.project.working_dir": dirname(compose),
              "com.docker.compose.project.config_files": compose,
            },
          },
        ]);
      });
    }

    /** The operations of one kind the agent admitted. */
    function admitted(kind: string) {
      return journal.records().filter((record) => record.operation.kind === kind);
    }
    /** The API process stops right after a checkpoint the predicate names is written. */
    function stopAfter(ctx: JobContext, stops: (ctx: JobContext) => boolean) {
      const checkpoint = ctx.checkpoint;
      ctx.checkpoint = async (...args) => {
        await checkpoint(...args);
        if (stops(ctx)) throw Error("API stopped");
      };
    }
    /** The API process stops at the first checkpoint it would write in a state the predicate names. */
    function stopBefore(ctx: JobContext, stops: (ctx: JobContext) => boolean) {
      const checkpoint = ctx.checkpoint;
      ctx.checkpoint = async (...args) => {
        if (stops(ctx)) throw Error("API stopped");
        await checkpoint(...args);
      };
    }
    /** Another API process claims the job, as the job runner does once the claim lapsed. */
    async function reclaim(ctx: JobContext) {
      const [original] = await fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, ctx.jobId));
      const { claimAdminJob, jobCheckpoint } = await import("../admin-job-state"),
        reclaimed = await claimAdminJob(original!);
      ctx.execution = (
        reclaimed!.protocol as { execution: NonNullable<JobContext["execution"]> }
      ).execution;
      ctx.checkpointResult = jobCheckpoint(reclaimed!.result, reclaimed!.protocol);
      ctx.protocol = reclaimed!.protocol;
      ctx.checkpoint = async (result, progress, admissionKey, stepAddress, operations) => {
        const saved = await checkpointOwnedAdminJob(
          ctx.jobId,
          ctx.execution!,
          result,
          operations ?? (ctx.protocol?.operations as NonNullable<typeof operations>),
          progress,
          admissionKey,
          stepAddress,
          ctx.checkpointResult ?? {},
        );
        ctx.checkpointResult = saved.result;
        ctx.protocol = saved.protocol;
      };
      return original!;
    }
    const phase = (ctx: { protocol?: unknown }) =>
      (ctx.protocol as { candidate?: { phase?: string } } | undefined)?.candidate?.phase;

    it.each([false, true])(
      "applies a coordinator credential through one record, each step once (lost settle reply=%s)",
      async (loseSettleResponseOnce) => {
        const dmRow = await coordinator({ loseSettleResponseOnce });
        const ctx = await job();
        await owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-applied-credential");
          replaceOnRecreate(dmRow, () => candidate.revisionId);
          const { application, saved } = await prospective.persistAndApplyProspectiveConfiguration(
            candidate,
            { coordinatorMode: "require-running", signal: ctx.signal },
          );
          expect(saved).toBe("committed");
          expect(application).toMatchObject({
            outcome: "committed",
            revisionId: candidate.revisionId,
            followUp: "complete",
          });
          expect(services.currentConfigurationGeneration(host.infraDir)).toBe(candidate.revisionId);
          const record = agentRecord(ctx);
          expect(record).toMatchObject({
            state: "settled",
            generation: "committed",
            appliedRevisionId: candidate.revisionId,
            followUp: "complete",
            fenceOutcome: "applied",
            fence: { state: "settled" },
          });
          expect(record.steps.every((step) => step.outcome === "committed")).toBe(true);
          // The job's copy is the agent's record, as the settle returned it.
          expect(
            maintenanceRecordSchema.parse(
              operations(ctx, "configurationMaintenance.settle")[0]?.result,
            ),
          ).toEqual(record);
          expect(phase(ctx)).toBe("generation_applied");
          expect(await dm!.fenceStates()).toEqual(["settled"]);
          if (loseSettleResponseOnce) expect(dm!.settlementResponseStatuses).toEqual([200, 200]);
          expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
          expect(heldTargets(host.infraDir)).toEqual([]);
          expect(readdirSync(host.candidates)).toEqual([]);
          expect(JSON.stringify(ctx.checkpointResult)).not.toContain(
            "synthetic-applied-credential",
          );
          // Applied once: the job's own apply under its key answers the same.
          expect(
            await prospective.settleConfigurationMaintenance(record.maintenanceId, "complete"),
          ).toEqual(record);
        });
      },
      180000,
    );

    it("abandons the prepared maintenance unused when the save rolls back", async () => {
      await coordinator();
      const ctx = await job();
      await owned(ctx, async () => {
        const candidate = await credentialCandidate(ctx, "synthetic-rollback-credential");
        await fixture.sql`ALTER TABLE service_secret ADD CONSTRAINT fixture_reject_desired_token CHECK (key <> 'TOKEN')`;
        const { application } = await prospective.persistAndApplyProspectiveConfiguration(
          candidate,
          { coordinatorMode: "require-running", signal: ctx.signal },
        );
        expect(application).toMatchObject({ outcome: "not_committed", reason: "conflict" });
        expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
        expect(services.currentConfigurationGeneration(host.infraDir)).toBe(
          host.initial.revisionId,
        );
        // The job carries no candidate any more; it settled its maintenance `abandon`.
        expect(phase(ctx)).toBeUndefined();
        expect(
          operations(ctx, "configurationMaintenance.settle").map(
            (operation) => (operation.operation as { outcome?: string }).outcome,
          ),
        ).toEqual(["abandon"]);
        expect(agentRecord(ctx)).toMatchObject({
          state: "settled",
          generation: "not_started",
          followUp: "not_started",
          fenceOutcome: "unused",
          fence: { state: "settled" },
        });
        expect(agentRecord(ctx).steps.every((step) => step.state === "pending")).toBe(true);
        expect(heldTargets(host.infraDir)).toEqual([]);
        expect(host.calls.some((args) => args.includes("up") || args.includes("restart"))).toBe(
          false,
        );
      });
      // The writer is free again.
      const next = await job();
      await owned(next, async () =>
        expect(writer.currentAdministrativeConfigurationWriter()).toBeDefined(),
      );
    }, 120000);

    it("continues a saved candidate after the API stopped, applying each step once", async () => {
      const dmRow = await coordinator();
      const ctx = await job();
      let revisionId = "";
      replaceOnRecreate(dmRow, () => revisionId);
      // The API stops right after the rows were saved, before it applies.
      stopBefore(ctx, (current) => phase(current) === "rows_saved");
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-recovered-credential");
          revisionId = candidate.revisionId;
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
      ).rejects.toThrow("API stopped");
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      const original = await reclaim(ctx);
      expect(phase(original)).toBe("rows_saved");
      expect(admitted("configurationMaintenance.apply")).toHaveLength(0);
      const resumed = await owned(ctx, () => prospective.resumeConfigurationCandidate());
      expect(resumed).toMatchObject({
        configuration: { outcome: "committed", revisionId, followUp: "complete" },
      });
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(revisionId);
      expect(agentRecord(ctx)).toMatchObject({ state: "settled", generation: "committed" });
      expect(admitted("configurationMaintenance.apply")).toHaveLength(1);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(heldTargets(host.infraDir)).toEqual([]);
      expect(readdirSync(host.candidates)).toEqual([]);
    }, 180000);

    it("writes the saved phase in the rows' transaction: a failed phase write saves no rows", async () => {
      await coordinator();
      const ctx = await job();
      // The job row refuses the saved phase; the rows written before it in the
      // same transaction roll back with it.
      await fixture.sql.unsafe(`
        CREATE FUNCTION fixture_refuse_saved_phase() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN
          IF NEW.protocol->'candidate'->>'phase' = 'rows_saved' THEN
            RAISE EXCEPTION 'synthetic phase write failure';
          END IF;
          RETURN NEW;
        END $$;
        CREATE TRIGGER fixture_refuse_saved_phase BEFORE UPDATE ON admin_job
          FOR EACH ROW EXECUTE FUNCTION fixture_refuse_saved_phase();`);
      await owned(ctx, async () => {
        const candidate = await credentialCandidate(ctx, "synthetic-unsaved-credential");
        const { application } = await prospective.persistAndApplyProspectiveConfiguration(
          candidate,
          { coordinatorMode: "require-running", signal: ctx.signal },
        );
        expect(application).toMatchObject({ outcome: "not_committed", reason: "conflict" });
      });
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
      const [row] = await fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, ctx.jobId));
      expect(phase(row!)).toBeUndefined();
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(agentRecord(ctx)).toMatchObject({
        state: "settled",
        generation: "not_started",
        fenceOutcome: "unused",
      });
      expect(admitted("configurationMaintenance.apply")).toHaveLength(0);
      expect(heldTargets(host.infraDir)).toEqual([]);
    }, 120000);

    it("abandons an immediate job's prepared maintenance unused when the API stopped before the save", async () => {
      await coordinator();
      const ctx = await job({ immediate: true });
      // The API stops once the maintenance is prepared, before the save.
      stopAfter(
        ctx,
        (current) =>
          phase(current) === "candidate_prepared" &&
          operations(current, "configurationMaintenance.prepare").some(
            (operation) => (operation as { terminal?: boolean }).terminal,
          ),
      );
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-abandoned-credential");
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
        // The stop lands in the preparation's terminal checkpoint, which the
        // operation's observer reports as an observation still pending.
      ).rejects.toThrow("Administrative job observation is pending");
      expect(phase(ctx)).toBe("candidate_prepared");
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
      expect(agentRecord(ctx).state).toBe("prepared");
      expect(heldTargets(host.infraDir)).not.toEqual([]);
      await reclaim(ctx);
      // An immediate job keeps no intent to rerun: it ends without the change.
      const resumed = await owned(ctx, () => prospective.resumeConfigurationCandidate());
      expect(resumed).toMatchObject({
        configuration: { outcome: "not_committed", reason: "conflict" },
      });
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(agentRecord(ctx)).toMatchObject({
        state: "settled",
        generation: "not_started",
        fenceOutcome: "unused",
        fence: { state: "settled" },
      });
      expect(admitted("configurationMaintenance.apply")).toHaveLength(0);
      expect(await dm!.fenceStates()).toEqual(["settled"]);
      expect(heldTargets(host.infraDir)).toEqual([]);
      expect(readdirSync(host.candidates)).toEqual([]);
    }, 180000);

    it("continues a queued job's prepared candidate after the API stopped before the save", async () => {
      const dmRow = await coordinator();
      const ctx = await job();
      let revisionId = "";
      replaceOnRecreate(dmRow, () => revisionId);
      stopAfter(
        ctx,
        (current) =>
          phase(current) === "candidate_prepared" &&
          operations(current, "configurationMaintenance.prepare").some(
            (operation) => (operation as { terminal?: boolean }).terminal,
          ),
      );
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-continued-credential");
          revisionId = candidate.revisionId;
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
      ).rejects.toThrow("Administrative job observation is pending");
      expect(phase(ctx)).toBe("candidate_prepared");
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
      await reclaim(ctx);
      // A queued job's candidate continues: the same preparation, then the save and the apply.
      const resumed = await owned(ctx, () => prospective.resumeConfigurationCandidate());
      expect(resumed).toMatchObject({
        configuration: { outcome: "committed", revisionId, followUp: "complete" },
      });
      expect(admitted("configurationMaintenance.prepare")).toHaveLength(1);
      expect(admitted("configurationMaintenance.apply")).toHaveLength(1);
      expect(await fixture.db.select().from(schema.serviceSecret)).toHaveLength(1);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(revisionId);
      expect(phase(ctx)).toBe("generation_applied");
      expect(heldTargets(host.infraDir)).toEqual([]);
      expect(readdirSync(host.candidates)).toEqual([]);
    }, 180000);

    it("records the apply's outcome once when the API stopped before the applied phase", async () => {
      const dmRow = await coordinator();
      const ctx = await job({ immediate: true });
      let revisionId = "";
      replaceOnRecreate(dmRow, () => revisionId);
      stopAfter(
        ctx,
        (current) =>
          phase(current) === "rows_saved" && current.checkpointResult?.configuration !== undefined,
      );
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-outcome-credential");
          revisionId = candidate.revisionId;
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
      ).rejects.toThrow("API stopped");
      await reclaim(ctx);
      // From the saved rows on an immediate job finishes: the apply and the
      // settle it already sent are observed again, never sent again.
      const resumed = await owned(ctx, () => prospective.resumeConfigurationCandidate());
      expect(resumed).toMatchObject({ configuration: { outcome: "committed", revisionId } });
      expect(admitted("configurationMaintenance.apply")).toHaveLength(1);
      expect(admitted("configurationMaintenance.settle")).toHaveLength(1);
      expect(phase(ctx)).toBe("generation_applied");
      expect(readdirSync(host.candidates)).toEqual([]);
      // A further run of a finished candidate sends nothing to the agent.
      const before = journal.records().length;
      await reclaim(ctx);
      expect(await owned(ctx, () => prospective.resumeConfigurationCandidate())).toMatchObject({
        configuration: { outcome: "committed", revisionId },
      });
      expect(journal.records()).toHaveLength(before);
    }, 180000);

    it("settles an applied maintenance once when the API stopped before the settle", async () => {
      const dmRow = await coordinator();
      const ctx = await job();
      let revisionId = "";
      replaceOnRecreate(dmRow, () => revisionId);
      stopAfter(
        ctx,
        () =>
          admitted("configurationMaintenance.apply").some(
            (record) => record.state === "succeeded",
          ) && admitted("configurationMaintenance.settle").length === 0,
      );
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-settled-credential");
          revisionId = candidate.revisionId;
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
      ).rejects.toThrow("API stopped");
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(revisionId);
      expect(agentRecord(ctx).state).toBe("applying");
      await reclaim(ctx);
      const resumed = await owned(ctx, () => prospective.resumeConfigurationCandidate());
      expect(resumed).toMatchObject({
        configuration: { outcome: "committed", revisionId, followUp: "complete" },
      });
      // The generation and the recreate ran once; the reclaimed job only settled.
      expect(admitted("configurationMaintenance.apply")).toHaveLength(1);
      expect(admitted("configurationMaintenance.settle")).toHaveLength(1);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(agentRecord(ctx)).toMatchObject({ state: "settled", fenceOutcome: "applied" });
      expect(heldTargets(host.infraDir)).toEqual([]);
    }, 180000);

    it("lets the step in flight end after a cancel and settles once the job runs again", async () => {
      const dmRow = await coordinator();
      const ctx = await job(),
        handler = new AbortController();
      ctx.signal = handler.signal;
      let revisionId = "";
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      replaceOnRecreate(
        dmRow,
        () => revisionId,
        async () => {
          entered.resolve();
          await release.promise;
        },
      );
      const applying = owned(ctx, async () => {
        const candidate = await credentialCandidate(ctx, "synthetic-cancelled-credential");
        revisionId = candidate.revisionId;
        return prospective.persistAndApplyProspectiveConfiguration(candidate, {
          coordinatorMode: "require-running",
          signal: ctx.signal,
        });
      });
      void applying.catch(() => undefined);
      await entered.promise;
      const { jobRunner } = await import("../job-runner");
      // The runner stops its own handler; the recreate in flight keeps the job held.
      const cancelled = jobRunner.cancel(ctx.jobId);
      handler.abort();
      expect(await cancelled).toBe(false);
      expect(agentRecord(ctx).cancelRequestedAt).not.toBeNull();
      await expect(applying).rejects.toThrow();
      release.resolve();
      await vi.waitFor(
        () =>
          expect(admitted("configurationMaintenance.apply")[0]?.state).toMatch(/succeeded|failed/),
        { timeout: 30000, interval: 100 },
      );
      // The reclaimed job observes the outcome, as the runner does after a cancel.
      await reclaim(ctx);
      ctx.signal = new AbortController().signal;
      await fixture.db
        .update(schema.adminJob)
        .set({ status: "running" })
        .where(eq(schema.adminJob.id, ctx.jobId));
      const resumed = await owned(ctx, () => prospective.resumeConfigurationCandidate());
      // The step in flight was the last one: it completed once and nothing else started.
      expect(resumed).toMatchObject({ configuration: { outcome: "committed", revisionId } });
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(admitted("configurationMaintenance.apply")).toHaveLength(1);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(revisionId);
      expect(agentRecord(ctx)).toMatchObject({ state: "settled", generation: "committed" });
      expect(heldTargets(host.infraDir)).toEqual([]);
      expect(readdirSync(host.candidates)).toEqual([]);
    }, 180000);

    it("keeps the lease of a maintenance needing recovery until the operator resolves it", async () => {
      await coordinator();
      const ctx = await job();
      // The recreate's outcome is lost: the step is unknown.
      host.setCreatingProcess(async () => {
        throw Error("synthetic lost recreate");
      });
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-unknown-credential");
          return prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
      ).rejects.toMatchObject({ reason: "recovery_required" });
      const record = agentRecord(ctx);
      expect(record.state).toBe("recovery_required");
      expect(record.steps.at(-1)).toMatchObject({ state: "terminal", outcome: "unknown" });
      expect(heldTargets(host.infraDir)).toContain("data-manager");
      expect(await dm!.fenceStates()).toEqual(["prepared"]);
      // The job's next run neither settles nor releases it.
      await reclaim(ctx);
      await expect(
        owned(ctx, () => prospective.resumeConfigurationCandidate()),
      ).rejects.toMatchObject({ reason: "recovery_required" });
      expect(agentRecord(ctx).state).toBe("recovery_required");
      expect(heldTargets(host.infraDir)).toContain("data-manager");
      // `openmapx control resolve --as failed` settles the record and the fence.
      const { openLeaseStore, leaseStoreDirectory } = await import(
        "@openmapx/core/build-artifacts"
      );
      const lease = openLeaseStore({
        directory: leaseStoreDirectory(host.infraDir),
        purpose: "test operator",
      })
        .list()
        .find((value) => value.ownerKind === "configurationMaintenance.prepare");
      const { settleMaintenanceFence } = await import(
        "../../../../../packages/cli/src/lib/control-resolve"
      );
      // The CLI presents the host CLI's own data-manager token.
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(`${dm!.token}-cli`));
      await settleMaintenanceFence(host.infraDir, lease!, "failed");
      expect(agentRecord(ctx)).toMatchObject({
        state: "settled",
        fenceOutcome: "applied",
        fence: { state: "settled" },
      });
      expect(await dm!.fenceStates()).toEqual(["settled"]);
    }, 120000);

    it("settles a preparation data-manager refuses, releases its targets and saves nothing", async () => {
      await coordinator();
      // A running data job keeps data-manager from preparing the fence. Data-
      // manager's tables are shared by every fixture, so the job is removed after.
      const dataJob = randomUUID();
      await fixture.sql`INSERT INTO data_manager.jobs(id,kind,status,operation_key)
        VALUES(${dataJob},'download-fonts','running',${`opk1_${randomUUID().replaceAll("-", "")}`})`;
      const ctx = await job();
      const outcome = await owned(ctx, async () => {
        const candidate = await credentialCandidate(ctx, "synthetic-refused-credential");
        return prospective.persistAndApplyProspectiveConfiguration(candidate, {
          coordinatorMode: "require-running",
          signal: ctx.signal,
        });
      })
        .then(
          (value) => ({ value }),
          (error: Error & { errorClass?: unknown }) => ({ error: error.errorClass }),
        )
        .finally(() => fixture.sql`DELETE FROM data_manager.jobs WHERE id=${dataJob}`);
      // The job fails busy without recovery: no fence, no rows, no generation.
      expect(outcome).toEqual({ error: "busy" });
      expect(await dm!.fenceStates()).toEqual([]);
      expect(phase(ctx)).toBeUndefined();
      expect(readdirSync(host.candidates)).toEqual([]);
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(agentRecord(ctx)).toMatchObject({
        state: "settled",
        generation: "not_started",
        fence: null,
      });
      expect(admitted("configurationMaintenance.apply")).toHaveLength(0);
      expect(heldTargets(host.infraDir)).toEqual([]);
    }, 120000);

    it("refuses the same immediate key with a different intent before any effect", async () => {
      await coordinator();
      const { jobRunner } = await import("../job-runner");
      const request = (value: string) =>
        jobRunner.applyImmediateConfiguration({
          kind: "serviceConfig.apply",
          serviceId: "data-manager",
          actorId: "fixture-admin",
          operationKey: "opk1_fixturesamekeyconflict00",
          expectedCurrentRevisionId: host.initial.revisionId,
          followUp: "service-apply",
          coordinatorMode: "require-running",
          overlay: {
            purpose: "service-secret",
            coordinatorMode: "require-running",
            changes: [
              {
                kind: "service-secret",
                serviceId: "data-manager",
                key: "TOKEN",
                action: "set",
                value,
              },
            ],
          },
        } as Parameters<typeof jobRunner.applyImmediateConfiguration>[0]);
      const { apiKeyedDigest } = await import("../admin-job-digest");
      // The first request under this key was admitted with another intent.
      await fixture.db.insert(schema.adminJob).values({
        id: randomUUID(),
        type: "service.apply",
        payload: { operationKey: "opk1_fixturesamekeyconflict00" },
        status: "success",
        protocol: {
          immediate: {
            actorId: "fixture-admin",
            intentDigest: apiKeyedDigest("immediate-configuration-intent", { other: true }),
          },
        },
      });
      await expect(request("synthetic-conflicting-credential")).rejects.toMatchObject({
        message: "Retained configuration intent conflicts",
      });
      expect(journal.records()).toEqual([]);
      expect(await fixture.db.select().from(schema.serviceSecret)).toEqual([]);
    }, 60000);
  },
);
