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
      const journal = await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json"));
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
    /** The record the job's maintenance checkpoint names, read from the agent's state. */
    function agentRecord(ctx: JobContext) {
      const checkpoint = ctx.checkpointResult?._configurationMaintenance as
        | { maintenanceId?: string }
        | undefined;
      return readMaintenance(installation, String(checkpoint?.maintenanceId)).record;
    }
    /** After a recreate the replacing container runs the new generation. */
    function replaceOnRecreate(
      dmRow: Awaited<ReturnType<typeof coordinator>>,
      revisionId: () => string,
    ) {
      host.setCreatingProcess(async () => {
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
          // The API's copy is the agent's record, as the settle returned it.
          expect(
            maintenanceRecordSchema.parse(
              (ctx.checkpointResult?._configurationMaintenance as { record?: unknown }).record,
            ),
          ).toEqual(record);
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
        expect(ctx.checkpointResult).toMatchObject({
          _configurationCandidate: { phase: "discarded" },
          _configurationMaintenanceSettle: { outcome: "abandon" },
          _configurationMaintenance: { phase: "settled" },
        });
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
      const ctx = await job(),
        checkpoint = ctx.checkpoint;
      let revisionId = "";
      replaceOnRecreate(dmRow, () => revisionId);
      // The API stops right after the rows were saved, before it applies.
      ctx.checkpoint = async (...args) => {
        await checkpoint(...args);
        if ((args[0]._configurationCandidate as { phase?: string } | undefined)?.phase === "saved")
          throw Error("API stopped after the save");
      };
      await expect(
        owned(ctx, async () => {
          const candidate = await credentialCandidate(ctx, "synthetic-recovered-credential");
          revisionId = candidate.revisionId;
          await prospective.persistAndApplyProspectiveConfiguration(candidate, {
            coordinatorMode: "require-running",
            signal: ctx.signal,
          });
        }),
      ).rejects.toThrow("API stopped after the save");
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      const [original] = await fixture.db
        .select()
        .from(schema.adminJob)
        .where(eq(schema.adminJob.id, ctx.jobId));
      expect(
        (original!.result as { _configurationCandidate?: { phase?: string } })
          ._configurationCandidate?.phase,
      ).toBe("saved");
      const { claimAdminJob } = await import("../admin-job-state"),
        reclaimed = await claimAdminJob(original!);
      ctx.execution = (
        reclaimed!.protocol as { execution: NonNullable<JobContext["execution"]> }
      ).execution;
      ctx.checkpointResult = reclaimed!.result as Record<string, unknown>;
      ctx.protocol = reclaimed!.protocol;
      // The reclaimed job checkpoints under its new execution.
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
      const resumed = await owned(ctx, () => prospective.resumeRetainedConfigurationCandidate());
      expect(resumed).toMatchObject({
        configuration: { outcome: "committed", revisionId, followUp: "complete" },
      });
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(revisionId);
      expect(agentRecord(ctx)).toMatchObject({ state: "settled", generation: "committed" });
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(heldTargets(host.infraDir)).toEqual([]);
      expect(readdirSync(host.candidates)).toEqual([]);
    }, 180000);
  },
);
