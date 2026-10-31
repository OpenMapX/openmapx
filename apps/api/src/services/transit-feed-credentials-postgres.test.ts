import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { closeControlInstallation, openControlInstallation } from "@openmapx/core/build-artifacts";
import { services } from "@openmapx/core/server";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedDataManager } from "../../../ops-agent/src/__fixtures__/owned-data-manager";
import { ownedServiceHost } from "../../../ops-agent/src/__fixtures__/owned-service-host";
import { installPinnedCredentialCatalog } from "../../../ops-agent/src/__fixtures__/pinned-feed-credentials";
import { openOpsJobJournal } from "../../../ops-agent/src/journal";
import { buildOpsAgentServer } from "../../../ops-agent/src/server";
import { createConfigurationPostgresFixture } from "../test/configuration-postgres-fixture";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createConfigurationPostgresFixture>>,
  services: [] as services.LoadedService[],
}));
vi.mock("../db", () => ({
  get db() {
    return state.fixture.db;
  },
  get sql() {
    return state.fixture.sql;
  },
}));
vi.mock("../integration-host", () => ({ getAllIntegrations: () => [] }));
vi.mock("./service-registry", () => ({
  getServiceRegistry: () => ({
    list: () => state.services,
    get: (id: string) => state.services.find((service) => service.manifest.id === id),
    applyEnabledIds: (ids: Set<string>) => {
      for (const service of state.services) service.enabled = ids.has(service.manifest.id);
    },
  }),
}));

import { AdminActionReauthentication } from "../account/admin-reauthentication";
import * as schema from "../db/schema";
import { jobRunner } from "./job-runner";
import { decrypt, encrypt } from "./secrets";
import { bindTransitCredentialAuthorization } from "./transit-credential-authorization";
import { transitCredentialRevision } from "./transit-credential-revision";
import { inspectFeedCredentials, previewFeedCredentialChanges } from "./transit-feed-credentials";

const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
describe.skipIf(!enabled)(
  "actual pinned managed credentials / original configuration maintenance / PostgreSQL",
  () => {
    let pauseKind = "vault.apply";
    let faults = false;
    const dropped = new Set<string>();
    let stopCoordinator: () => void;
    let nativeRecovery = false;
    let releaseAdmission: (() => void) | undefined;
    const children: ReturnType<typeof spawn>[] = [];
    let ackReplies: unknown[] = [];
    let wire: unknown[] = [];
    let journal: Awaited<ReturnType<typeof openOpsJobJournal>>;

    let migrated: Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
      host: Awaited<ReturnType<typeof ownedServiceHost>>,
      agent: ReturnType<typeof buildOpsAgentServer>,
      installation: ReturnType<typeof openControlInstallation>,
      dm: Awaited<ReturnType<typeof ownedDataManager>>;
    beforeAll(async () => {
      migrated = await createMigratedPostgresFixture();
    }, 90000);
    afterAll(async () => {
      await migrated?.stop();
    });
    beforeEach(async (context) => {
      faults = context.task.name.startsWith("consumes one real");
      dropped.clear();
      nativeRecovery = context.task.name.includes("killed native");
      pauseKind = context.task.name.includes("phase=prepared")
        ? "configurationMaintenance.prepare"
        : "vault.apply";
      vi.stubEnv("OPENMAPX_RELEASE", "local");
      vi.stubEnv("OPENMAPX_ADMIN_JOB_TEST_DATABASE_URL", migrated.connectionUri);
      vi.stubEnv("OPENMAPX_SECRETS_KEY", "71".repeat(32));
      state.fixture = await createConfigurationPostgresFixture({
        withAccountAdministration: true,
        withConfigurationMigration: context.task.name.startsWith("staged"),
      });
      const schemas = Object.fromEntries(
        ["motis", "ops-agent", "app-api", "traefik", "postgis", "redis", "data-manager"].map(
          (id) => [
            id,
            {
              type: "object",
              properties: {
                TRANSITOUS_API_KEYS: { type: "string", "x-openmapx-secret": true },
                ORDINARY_TOKEN: { type: "string", "x-openmapx-secret": true },
              },
            },
          ],
        ),
      );
      host = await ownedServiceHost({
        schemas,
        actualComposeConfig: true,
        withCoordinator: true,
        withHardlinks: !context.task.name.includes("empty-plan"),
      });
      state.services = host.loaded;
      installation = openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((service) => service.manifest.id),
      });
      await installPinnedCredentialCatalog(host.root, installation);
      journal = await openOpsJobJournal(join(host.infraDir, "state/ops-agent/jobs-v1.json"));
      agent = buildOpsAgentServer({
        tokens: { api: host.token, "data-manager": Buffer.alloc(32, 23).toString("base64url") },
        runtime: host.runtime,
        resourceClaimer: host.claimer,
        journal,
        controlInstallation: installation,
      });
      ackReplies = [];
      wire = [];
      agent.addHook("preHandler", async (request) => {
        const kind = (request.body as { operation?: { kind?: string } } | undefined)?.operation
          ?.kind;
        if (kind) wire.push({ kind, phase: "entered", at: Date.now() });
      });
      agent.addHook("onSend", async (request, reply, payload) => {
        if ((request.body as { operation?: { kind?: string } } | undefined)?.operation?.kind) {
          const body = typeof payload === "string" ? JSON.parse(payload) : {};
          const kind = (request.body as { operation: { kind: string } }).operation.kind;
          wire.push({
            kind,
            phase: "response",
            status: reply.statusCode,
            errorClass: body.error?.class,
            at: Date.now(),
          });
          if (
            faults &&
            [
              "configurationMaintenance.prepare",
              "configurationMaintenance.decide",
              "configurationMaintenance.settle",
            ].includes(kind) &&
            reply.statusCode === 202 &&
            !dropped.has(kind)
          ) {
            dropped.add(kind);
            reply.raw.destroy();
          }
          if (kind === "controlRetention.acknowledge")
            ackReplies.push({
              status: reply.statusCode,
              code: body.error?.class,
              message: body.error?.message,
            });
        }
        if (
          nativeRecovery &&
          (request.body as { operation?: { kind?: string } } | undefined)?.operation?.kind ===
            pauseKind &&
          reply.statusCode === 202
        )
          await new Promise<void>((resolve) => {
            releaseAdmission = resolve;
          });
        return payload;
      });
      const url = await agent.listen({ host: "127.0.0.1", port: 0 }),
        token = join(host.root, "api-token");
      writeFileSync(token, host.token, { mode: 0o600 });
      for (const [key, value] of Object.entries({
        OPS_AGENT_URL: url,
        OPS_AGENT_TOKEN_FILE: token,
        OPS_TRUSTED_CONFIG_DIR: host.queue,
        OPS_TRUSTED_CONFIG_UID: String(statSync(host.queue).uid),
        OPS_TRUSTED_CONFIG_GID: String(statSync(host.queue).gid),
      }))
        vi.stubEnv(key, value);
      dm = await ownedDataManager({
        sql: state.fixture.sql,
        infraDir: host.infraDir,
        serviceIds: host.loaded.map((service) => service.manifest.id),
        losePrepareResponse: faults,
        loseHardlinkResponse: faults,
        observeSettlementSql: true,
        loseSettlementCommitAcknowledgement: faults,
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
      stopCoordinator = () => host.setRows([host.row, { ...dmRow, State: "exited" }]);
      host.setCreatingProcess(async (args) => {
        if (!args.includes("--force-recreate")) return;
        const revision = services.currentConfigurationGeneration(host.infraDir)!;
        const compose = services.stackComposeArgs(host.stack),
          options = {
            signal: new AbortController().signal,
            timeout: 15000,
            maxBuffer: 1024 * 1024,
          };
        const config = JSON.parse(
            (await host.execFile("docker", [...compose, "config", "--format", "json"], options))
              .stdout,
          ),
          hash = (
            await host.execFile("docker", [...compose, "config", "--hash", "data-manager"], options)
          ).stdout
            .trim()
            .split(/\s+/)
            .at(-1)!;
        const row = {
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
    }, 90000);
    afterEach(async () => {
      releaseAdmission?.();
      releaseAdmission = undefined;
      for (const child of children)
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      children.length = 0;
      await dm?.close();
      await agent?.close();
      if (installation) closeControlInstallation(installation);
      await state.fixture?.stop();
      if (host) rmSync(host.root, { recursive: true, force: true });
      vi.unstubAllEnvs();
      state.services = [];
    });
    async function authorizedInput(options: { seed?: boolean } = {}) {
      const actor = randomUUID();
      await state.fixture.db.insert(schema.user).values({
        id: actor,
        name: "Synthetic admin",
        email: `${actor}@example.test`,
        emailVerified: true,
        role: "admin",
      });
      const login = async () => {
        const id = randomUUID(),
          at = new Date();
        await state.fixture.db.insert(schema.session).values({
          id,
          userId: actor,
          token: randomUUID(),
          expiresAt: new Date(Date.now() + 3600000),
          createdAt: at,
          updatedAt: at,
        });
        await state.fixture.db.insert(schema.sessionAuthAssurance).values({
          sessionId: id,
          userId: actor,
          method: "password",
          authenticatedAt: at,
          originIndependentPasswordLogin: true,
        });
        return {
          id,
          userId: actor,
          authenticatedAt: at,
          method: "password" as const,
          mfaConfigured: false,
        };
      };
      const old = await login(),
        operationKey = `opk1_${randomUUID().replaceAll("-", "")}`;
      const { readCatalogPinSet } = await import("@openmapx/core/catalog-pins");
      const catalog = readCatalogPinSet(host.root)!.generationId;
      const prior = {
        id: randomUUID(),
        serviceId: "data-manager",
        key: "TRANSITOUS_API_KEYS",
        ...encrypt('{"orphan":" untouched "}'),
        createdAt: new Date(),
        updatedAt: new Date(),
        updatedBy: null,
      };
      if (options.seed !== false) await state.fixture.db.insert(schema.serviceSecret).values(prior);
      const [currentRow] = await state.fixture.db.select().from(schema.serviceSecret);
      const preview = await previewFeedCredentialChanges({
        actorId: actor,
        catalogRevisionId: catalog,
        expectedCredentialsRevision: transitCredentialRevision(currentRow),
        expectedCurrentRevisionId: services.currentConfigurationGeneration(host.infraDir),
        changes: [{ key: "de/A", action: "set", value: "synthetic-private-key" }],
        operationKey,
      });
      const reauth = new AdminActionReauthentication(state.fixture.db),
        challenge = await reauth.start({
          actorId: actor,
          startingSessionId: old.id,
          purpose: "transit.credentials",
          targetId: catalog,
          intentFingerprint: preview.intentFingerprint,
        });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const fresh = await login();
      await reauth.complete({
        challengeId: challenge.challengeId,
        nonce: challenge.nonce,
        session: fresh,
      });
      const input = {
        actorId: actor,
        previewId: preview.previewId,
        intentFingerprint: preview.intentFingerprint,
        operationKey,
      };
      await bindTransitCredentialAuthorization({
        ...input,
        transitProofToken: challenge.challengeId,
        sessionId: fresh.id,
        nonce: challenge.nonce.toString("base64url"),
      });
      return { input, catalog, challenge, preview, sessionId: fresh.id, nonce: challenge.nonce };
    }
    it("staged mixed credential import consumes both proofs atomically under one original maintenance root", async () => {
      const { input: initial, catalog, sessionId } = await authorizedInput();
      const { previewCredentialTransfer } = await import(
        "./configuration-migration/credential-preview"
      );
      await state.fixture.db
        .update(schema.serviceSecret)
        .set(
          encrypt(
            JSON.stringify({
              orphan: "untouched",
              retained: "existing",
              unselected: "preserved orphan",
            }),
          ),
        )
        .where(eq(schema.serviceSecret.serviceId, "data-manager"));
      const importedMap = JSON.stringify({
        "de/A": "a".repeat(7000),
        orphan: "b".repeat(7000),
        retained: "c".repeat(7000),
      });
      // Actual declared source vault export under a different source master key.
      vi.stubEnv("OPENMAPX_SECRETS_KEY", "92".repeat(32));
      await state.fixture.db
        .update(schema.serviceSecret)
        .set(encrypt(importedMap))
        .where(eq(schema.serviceSecret.key, "TRANSITOUS_API_KEYS"));
      await state.fixture.db.insert(schema.serviceSecret).values({
        id: randomUUID(),
        serviceId: "data-manager",
        key: "ORDINARY_TOKEN",
        ...encrypt("synthetic ordinary credential"),
      });
      const { exportCredentialSelection } = await import(
        "./configuration-migration/credential-preview"
      );
      const envelope = await exportCredentialSelection({
        actorId: initial.actorId,
        selection: [
          { scope: "service", id: "data-manager", key: "ORDINARY_TOKEN" },
          { scope: "service", id: "data-manager", key: "TRANSITOUS_API_KEYS" },
        ],
        passphrase: "synthetic transfer passphrase",
      });
      await state.fixture.db.delete(schema.serviceSecret);
      vi.stubEnv("OPENMAPX_SECRETS_KEY", "71".repeat(32));
      await state.fixture.db.insert(schema.serviceSecret).values({
        id: randomUUID(),
        serviceId: "data-manager",
        key: "TRANSITOUS_API_KEYS",
        ...encrypt(
          JSON.stringify({
            orphan: "untouched",
            retained: "existing",
            unselected: "preserved orphan",
          }),
        ),
      });
      const [prior] = await state.fixture.db.select().from(schema.serviceSecret);
      const preview = await previewCredentialTransfer({
        actorId: initial.actorId,
        envelope,
        passphrase: "synthetic transfer passphrase",
        choices: {
          entries: [
            { scope: "service", id: "data-manager", key: "ORDINARY_TOKEN", action: "import" },
            { scope: "service", id: "data-manager", key: "TRANSITOUS_API_KEYS", action: "import" },
          ],
          feedMap: {
            catalogRevisionId: catalog,
            expectedCredentialsRevision: transitCredentialRevision(prior),
            setKeys: ["de/A", "orphan", "retained"],
            deleteKeys: [],
          },
        },
      });
      expect(preview.applyable).toBe(true);
      const reauth = new AdminActionReauthentication(state.fixture.db),
        importProof = await reauth.start({
          actorId: initial.actorId,
          startingSessionId: sessionId,
          purpose: "credentials.import",
          targetId: preview.previewId,
          intentFingerprint: preview.intentFingerprint,
        }),
        transitProof = await reauth.start({
          actorId: initial.actorId,
          startingSessionId: sessionId,
          purpose: "transit.credentials",
          targetId: catalog,
          intentFingerprint: preview.intentFingerprint,
          nonce: importProof.nonce,
        });
      await new Promise((resolve) => setTimeout(resolve, 2));
      const fresh = {
        id: randomUUID(),
        userId: initial.actorId,
        authenticatedAt: new Date(),
        method: "password" as const,
        mfaConfigured: false,
      };
      await state.fixture.db.insert(schema.session).values({
        id: fresh.id,
        userId: fresh.userId,
        token: randomUUID(),
        expiresAt: new Date(Date.now() + 3600000),
        createdAt: fresh.authenticatedAt,
        updatedAt: fresh.authenticatedAt,
      });
      await state.fixture.db.insert(schema.sessionAuthAssurance).values({
        sessionId: fresh.id,
        userId: fresh.userId,
        method: "password",
        authenticatedAt: fresh.authenticatedAt,
        originIndependentPasswordLogin: true,
      });
      for (const challengeId of [importProof.challengeId, transitProof.challengeId])
        await reauth.complete({ challengeId, nonce: importProof.nonce, session: fresh });
      const result = await jobRunner
        .runImmediateConfigurationMigration({
          actorId: initial.actorId,
          operationKey: `opk1_${randomUUID().replaceAll("-", "")}`,
          kind: "credentials",
          previewId: preview.previewId,
          fingerprint: preview.intentFingerprint,
          expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
          proof: {
            sessionId: fresh.id,
            nonce: importProof.nonce,
            importProofToken: importProof.challengeId,
            transitProofToken: transitProof.challengeId,
          },
        })
        .catch(async (error) => {
          const jobs = await state.fixture.db.select().from(schema.adminJob);
          console.log(
            "MIGRATION_FAILURE_DIAGNOSTIC",
            jobs.map((j) => {
              const r = j.result as Record<string, unknown> | null;
              return {
                status: j.status,
                type: j.type,
                failure: r?._migrationFailure,
                configuration: r?.configuration,
                phase: (r?._configurationCandidate as { phase?: unknown })?.phase,
              };
            }),
          );
          throw error;
        });
      expect(result.outcome).toBe("applied");
      const rows = await state.fixture.db.select().from(schema.serviceSecret),
        ordinary = rows.find((r) => r.key === "ORDINARY_TOKEN"),
        managed = rows.find((r) => r.key === "TRANSITOUS_API_KEYS");
      expect(ordinary && decrypt(ordinary.ciphertext, ordinary.iv, ordinary.tag)).toBe(
        "synthetic ordinary credential",
      );
      expect(managed && JSON.parse(decrypt(managed.ciphertext, managed.iv, managed.tag))).toEqual({
        "de/A": "a".repeat(7000),
        orphan: "b".repeat(7000),
        retained: "c".repeat(7000),
        unselected: "preserved orphan",
      });
      const proofs = await state.fixture.db.select().from(schema.adminActionReauthentication);
      expect(
        proofs
          .filter((p) => [importProof.challengeId, transitProof.challengeId].includes(p.id))
          .map((p) => p.state),
      ).toEqual(["consumed", "consumed"]);
      expect(dm.preparePosts).toBe(1);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(services.readAppliedTransitCredentialsRevision(host.infraDir)).toBe(
        transitCredentialRevision(managed),
      );
      const logs = await state.fixture.db.select().from(schema.adminJobLog),
        jobs = await state.fixture.db.select().from(schema.adminJob);
      expect(JSON.stringify({ logs, jobs })).not.toContain("synthetic ordinary credential");
      expect(JSON.stringify({ logs, jobs })).not.toContain("synthetic transfer passphrase");
    }, 90000);
    it("staged portable platform and pending auth share the same guarded candidate transaction", async () => {
      const { input } = await authorizedInput();
      const { createDurableOpsKey } = await import("./ops-client");
      const preview = await jobRunner.runImmediateConfigurationMigrationPreview({
        actorId: input.actorId,
        operationKey: createDurableOpsKey("migration.platform.preview", randomUUID()),
        document: {
          format: "openmapx-configuration",
          version: 1,
          exportedAt: new Date().toISOString(),
          settings: { instanceName: "Synthetic migrated instance", passwordMinLength: 12 },
          platform: { version: 1, backupRetentionDays: { source: "database", value: 60 } },
          integrations: [],
          serviceConfigs: [],
          bindings: [],
          installations: [],
          prerequisites: [],
        },
      });
      expect(preview.platform?.configuration.backupRetentionDays).toEqual({
        source: "database",
        value: 60,
      });
      const result = await jobRunner.runImmediateConfigurationMigration({
        actorId: input.actorId,
        operationKey: createDurableOpsKey("migration.platform.apply", randomUUID()),
        previewId: preview.previewId,
        fingerprint: preview.fingerprint,
        kind: "migration",
        platformAuthorization: {
          confirmations: {
            domain: false,
            dnsTls: false,
            oauth: false,
            passkeys: false,
            alternateLogin: false,
          },
        },
      });
      expect(result.outcome).toBe("partial");
      expect(result.steps.find((s) => s.id === "passwordMinLength")).toMatchObject({
        scope: "pending-auth",
        status: "pending",
      });
      const settings = await state.fixture.db.select().from(schema.systemSettings);
      expect(settings.find((r) => r.key === "passwordMinLength")?.value).toBe(12);
      await expect(
        (await import("../account/auth-policy")).loadAuthPolicy(state.fixture.db),
      ).resolves.toMatchObject({ passwordMinLength: 8 });
      expect(
        services.readAppliedConfiguration(host.infraDir).platform?.backupRetentionDays,
      ).toEqual({ source: "database", value: 60 });
      expect(dm.preparePosts).toBe(1);
    }, 90000);
    it("consumes one real purpose proof and commits a preserved map through one original guard, recreation and active mounted revision", async () => {
      const { input, catalog, challenge } = await authorizedInput();
      const competing = await authorizedInput({ seed: false }),
        applying = jobRunner.applyImmediateTransitCredentials(input);
      const until = Date.now() + 30000;
      while (dm.preparePosts === 0) {
        if (Date.now() > until) throw Error("Original preparation not observed");
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      await expect(jobRunner.applyImmediateTransitCredentials(competing.input)).rejects.toThrow();
      const result = await applying;
      const [unusedProof] = await state.fixture.db
        .select()
        .from(schema.adminActionReauthentication)
        .where(eq(schema.adminActionReauthentication.id, competing.challenge.challengeId));
      expect(unusedProof?.state).toBe("completed");
      expect(result.configuration).toMatchObject({ outcome: "committed", followUp: "complete" });
      const [row] = await state.fixture.db.select().from(schema.serviceSecret);
      expect(JSON.parse(decrypt(row!.ciphertext, row!.iv, row!.tag))).toEqual({
        orphan: " untouched ",
        "de/A": "synthetic-private-key",
      });
      expect(result.credentialsRevision).toBe(transitCredentialRevision(row));
      const [proof] = await state.fixture.db
        .select()
        .from(schema.adminActionReauthentication)
        .where(eq(schema.adminActionReauthentication.id, challenge.challengeId));
      expect(proof?.state).toBe("consumed");
      expect(dm.preparePosts).toBe(1);
      expect(dm.posts).toBe(1);
      expect(dm.settlementSqlIo).toEqual({ updates: 1, commits: 1 });
      expect(dropped.size).toBe(3);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(1);
      expect(services.readAppliedTransitCredentialsRevision(host.infraDir)).toBe(
        result.credentialsRevision,
      );
      const view = await inspectFeedCredentials({ catalogRevisionId: catalog });
      expect(view).toMatchObject({
        appliedCredentialsRevision: result.credentialsRevision,
        pendingApplication: false,
      });
      expect(JSON.stringify(view)).not.toContain("synthetic-private-key");
      expect(await jobRunner.applyImmediateTransitCredentials(input)).toEqual(result);
      expect(dm.preparePosts).toBe(1);
      const [job] = await state.fixture.db.select().from(schema.adminJob);
      expect(job?.status).toBe("success");
      const logs = await state.fixture.db.select().from(schema.adminJobLog),
        audit = await state.fixture.db.select().from(schema.adminAuditLog);
      expect(JSON.stringify({ logs, audit })).not.toContain("synthetic-private-key");
      expect(JSON.stringify({ payload: job?.payload, result: job?.result })).not.toContain(
        "synthetic-private-key",
      );
    }, 120000);
    it.each(["prepared", "saved"])(
      "recovers a killed native credential producer without consuming or applying twice (phase=%s)",
      async (phase) => {
        const { input } = await authorizedInput(),
          database = new URL(migrated.connectionUri);
        database.searchParams.set("search_path", state.fixture.schema);
        const loader = createRequire(new URL("../../package.json", import.meta.url)).resolve(
            "tsx/esm",
          ),
          script = fileURLToPath(
            new URL("./__tests__/fixtures/native-transit-credentials-api.ts", import.meta.url),
          );
        const start = (reconcile = false) => {
          const child = spawn(process.execPath, ["--import", loader, script], {
            cwd: host.root,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
              ...process.env,
              DATABASE_URL: database.toString(),
              OPENMAPX_ROOT_DIR: host.root,
              NODE_ENV: "test",
              BETTER_AUTH_SECRET: "synthetic-transit-native-auth-fixture",
            },
          });
          children.push(child);
          let output = "";
          child.stdout!.on("data", (chunk) => {
            output += chunk;
          });
          child.stderr!.on("data", () => {});
          const exited = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject);
            child.once("close", (code) => resolve(code));
          });
          child.stdin!.end(JSON.stringify({ ...input, reconcile }));
          return { child, exited, output: () => output };
        };
        const waitFor = async (check: () => boolean | Promise<boolean>, ms = 90000) => {
          const deadline = Date.now() + ms;
          while (!(await check())) {
            if (Date.now() > deadline) throw Error("Original credential checkpoint not observed");
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
        };
        const first = start();
        await waitFor(
          () =>
            Boolean(releaseAdmission) &&
            journal
              .records()
              .some(
                (record) => record.operation.kind === pauseKind && record.state === "succeeded",
              ),
        );
        const [before] = await state.fixture.db.select().from(schema.adminJob),
          [proof] = await state.fixture.db.select().from(schema.adminActionReauthentication),
          [secret] = await state.fixture.db.select().from(schema.serviceSecret);
        expect(proof?.state).toBe(phase === "saved" ? "consumed" : "completed");
        expect(
          (before!.result as { _configurationCandidate: { phase: string } })._configurationCandidate
            .phase,
        ).toBe(phase);
        first.child.kill("SIGKILL");
        await first.exited;
        releaseAdmission?.();
        releaseAdmission = undefined;
        const lease = (before!.result as { _observationLeaseUntil: string })._observationLeaseUntil;
        await new Promise((resolve) =>
          setTimeout(resolve, Math.max(0, Date.parse(lease) - Date.now() + 100)),
        );
        const replacement = start(true);
        const code = await replacement.exited;
        console.info(
          "Native recovery result",
          JSON.stringify({ code, output: replacement.output() }),
        );
        expect(code).toBe(phase === "saved" ? 0 : 2);
        const [after] = await state.fixture.db.select().from(schema.adminJob),
          [afterProof] = await state.fixture.db.select().from(schema.adminActionReauthentication),
          [afterSecret] = await state.fixture.db.select().from(schema.serviceSecret);
        expect(after?.id).toBe(before!.id);
        expect(after?.status).toBe(phase === "saved" ? "success" : "failed");
        expect(afterProof?.consumedAt).toEqual(proof?.consumedAt);
        expect(afterSecret).toEqual(secret);
        expect(dm.preparePosts).toBe(1);
        expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(
          phase === "saved" ? 1 : 0,
        );
        if (phase === "prepared") {
          const replay = await jobRunner.applyImmediateTransitCredentials(input);
          expect(replay.configuration.outcome).toBe("not_committed");
        }
        expect(
          (after!.result as { transitCredentials: { credentialsRevision: string } })
            .transitCredentials.credentialsRevision,
        ).toBe(transitCredentialRevision(secret));
      },
      240000,
    );

    it("refuses an empty-plan credential follow-up when the original DM is stopped, before proof consumption or admission", async () => {
      const { input, challenge } = await authorizedInput();
      stopCoordinator();
      const [before] = await state.fixture.db.select().from(schema.serviceSecret);
      await expect(jobRunner.applyImmediateTransitCredentials(input)).rejects.toThrow();
      expect(
        wire.filter(
          (value) => (value as { kind: string }).kind === "configurationMaintenance.prepare",
        ),
      ).toHaveLength(0);
      const [after] = await state.fixture.db.select().from(schema.serviceSecret),
        [proof] = await state.fixture.db
          .select()
          .from(schema.adminActionReauthentication)
          .where(eq(schema.adminActionReauthentication.id, challenge.challengeId));
      expect(after).toEqual(before);
      expect(proof?.state).toBe("completed");
      expect(dm.preparePosts).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
    }, 90000);
    it("rejects a nominal patch whose values differ from its immutable reviewed private preview", async () => {
      const { input, catalog, challenge, preview, sessionId, nonce } = await authorizedInput();
      const { withAdministrativeConfigurationJob, withAdministrativeConfigurationWriter } =
        await import("./administrative-configuration-writer-owner");
      const {
        withTransitCredentialProofContext,
        prepareFeedCredentialImportPatch,
        authorizePreparedFeedCredentialPatch,
      } = await import("./transit-feed-credential-participant");
      const attempted = Promise.withResolvers<void>();
      jobRunner.register("test.feed-credential-review", async (ctx) => {
        try {
          await withAdministrativeConfigurationJob(ctx, () =>
            withAdministrativeConfigurationWriter(
              { actorId: input.actorId, operationKey: input.operationKey, integrationIds: [] },
              async (writer) =>
                withTransitCredentialProofContext(
                  { actorId: input.actorId, sessionId, nonce },
                  async () => {
                    const patch = await prepareFeedCredentialImportPatch({
                      actorId: input.actorId,
                      catalogRevisionId: catalog,
                      expectedCredentialsRevision: preview.credentialsRevision,
                      expectedCurrentRevisionId: preview.expectedCurrentRevisionId,
                      changes: [{ key: "de/A", action: "set", value: "synthetic-private-kex" }],
                      importPreviewId: preview.previewId,
                      operationKey: input.operationKey,
                    });
                    await authorizePreparedFeedCredentialPatch({
                      patch,
                      writer,
                      authorization: { kind: "direct", transitProofToken: challenge.challengeId },
                      preview,
                    });
                  },
                ),
            ),
          );
          attempted.resolve();
          return {};
        } catch (error) {
          attempted.reject(error);
          throw error;
        }
      });
      const id = await jobRunner.enqueue("test.feed-credential-review", {}, input.actorId);
      const outcome = await attempted.promise.then(
        () => null,
        (error) => error,
      );
      await vi.waitFor(async () => {
        const [job] = await state.fixture.db
          .select()
          .from(schema.adminJob)
          .where(eq(schema.adminJob.id, id));
        expect(["success", "failed"]).toContain(job?.status);
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("TRANSIT_CREDENTIALS_CHANGED");
      const [proof] = await state.fixture.db
        .select()
        .from(schema.adminActionReauthentication)
        .where(eq(schema.adminActionReauthentication.id, challenge.challengeId));
      expect(proof?.state).toBe("completed");
      expect(dm.preparePosts).toBe(0);
      expect(host.calls.filter((args) => args.includes("--force-recreate"))).toHaveLength(0);
    }, 90000);
  },
);
