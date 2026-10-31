import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { OpsClient } from "@openmapx/core/ops";
import { afterAll, beforeAll, expect, it } from "vitest";
import { setupCron } from "../../cron";
import { db, rawSql } from "../../db";
import { resetOpsClient } from "../../ops-client";
import { StateStore } from "../../state";
import { createSingleFlightController } from "../transitous/single-flight";
import { installDataMutationAdmission } from "./admission";
import { createDataConfigurationMaintenance } from "./configuration-maintenance";
import { reconcileLegacyCatalogPreflightRejections } from "./legacy-mutation";

const enabled =
  Boolean(process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL) ||
  process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
let repository: string;
let root: string,
  installation: control.ControlInstallation,
  fence: ReturnType<typeof createDataConfigurationMaintenance>;
beforeAll(async () => {
  if (!enabled) return;
  if (
    !process.env.DATABASE_URL ||
    process.env.DATABASE_URL !== process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL
  )
    throw Error("Explicit production adapter must use the verified owned synthetic DB");
  repository = mkdtempSync(join(tmpdir(), "omx-fix1-legacy-"));
  root = join(repository, "infra/docker");
  mkdirSync(join(root, "data"), { recursive: true, mode: 0o700 });
  await control.provisionControlInstallation(root);
  installation = control.openControlInstallation({
    infraDir: root,
    role: "data-manager",
    serviceIds: ["data-manager", "motis", "motis-staging", "motis-feed-proxy"],
  });
  fence = createDataConfigurationMaintenance(rawSql, installation);
  await fence.startup();
  installDataMutationAdmission(fence);
});
afterAll(async () => {
  if (!enabled) return;
  control.closeControlInstallation(installation);
  await rawSql.end();
  rmSync(repository, { recursive: true, force: true });
});
it.skipIf(!enabled)(
  "I4 records actual missing-catalog preflight as terminal error and permits the first subsequent admission",
  async () => {
    const before = new Set(
      (await rawSql`SELECT id FROM data_manager.jobs`).map((row) => String(row.id)),
    );
    const cron = setupCron({
      dataDir: join(root, "data"),
      countries: ["de"],
      store: new StateStore(join(root, "data")),
      singleFlight: createSingleFlightController({ db, admissionSql: rawSql }),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
      syncCronExpression: "disabled",
      feedProxyReloadCronExpression: "disabled",
      stalenessCheckCronExpression: "disabled",
      autoBumpCronExpression: "disabled",
      trafficExtractCronExpression: "disabled",
      trafficLiveCronExpression: "disabled",
      trafficPredictedCronExpression: "disabled",
      overtureCronExpression: "disabled",
      overtureConflationRetryCronExpression: "disabled",
    });
    const owned: string[] = [];
    try {
      await expect(cron.runAutoBumpNow()).rejects.toMatchObject({ code: "catalog-not-cloned" });
      const rows = (
        await rawSql`SELECT id,status,finished_at,metadata FROM data_manager.jobs WHERE kind='transit-proposal'`
      ).filter((row) => !before.has(String(row.id)));
      owned.push(...rows.map((row) => String(row.id)));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status).toBe("error");
      expect(control.retainedDataDatabaseTimestamp(rows[0]?.finished_at).getTime()).toBeGreaterThan(
        0,
      );
      // Crash after the fixed no-effect fact, before terminal SQL publication.
      await rawSql`UPDATE data_manager.jobs SET status='interrupted',finished_at=NULL WHERE id=${rows[0]!.id}`;
      await reconcileLegacyCatalogPreflightRejections(rawSql);
      const [repaired] =
        await rawSql`SELECT status,finished_at FROM data_manager.jobs WHERE id=${rows[0]!.id}`;
      expect(repaired?.status).toBe("error");
      expect(repaired?.finished_at).not.toBeNull();
      await expect(fence.withAdmission(async () => "first sync may admit")).resolves.toBe(
        "first sync may admit",
      );
      const subsequent = await legacyFixture();
      try {
        const sync = await subsequent.app.inject({
          method: "POST",
          url: "/transit/sync",
          headers,
          payload: { countries: ["de"], triggeredBy: "bootstrap" },
        });
        expect(sync.statusCode, sync.body).toBe(202);
        await expect
          .poll(async () => (await subsequent.store.inspect(sync.json().jobId))?.status.status, {
            timeout: 15000,
          })
          .toBe("ok");
      } finally {
        await subsequent.close();
      }
    } finally {
      cron.stop();
      if (!owned.length)
        owned.push(
          ...(await rawSql`SELECT id FROM data_manager.jobs`)
            .map((row) => String(row.id))
            .filter((id) => !before.has(id)),
        );
      for (const id of owned) await rawSql`DELETE FROM data_manager.jobs WHERE id=${id}`;
    }
  },
  30000,
);

function proposalCron(overrides: Partial<Parameters<typeof setupCron>[0]> = {}) {
  return setupCron({
    dataDir: join(root, "data"),
    countries: ["de"],
    store: new StateStore(join(root, "data")),
    singleFlight: createSingleFlightController({ db, admissionSql: rawSql }),
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    syncCronExpression: "disabled",
    feedProxyReloadCronExpression: "disabled",
    stalenessCheckCronExpression: "disabled",
    autoBumpCronExpression: "disabled",
    trafficExtractCronExpression: "disabled",
    trafficLiveCronExpression: "disabled",
    trafficPredictedCronExpression: "disabled",
    overtureCronExpression: "disabled",
    overtureConflationRetryCronExpression: "disabled",
    ...overrides,
  });
}
it.skipIf(!enabled).each(["git", "proposal"] as const)(
  "I4 retains the original %s attempt as unknown and blocks admission after recovery",
  async (phase) => {
    const before = new Set(
      (await rawSql`SELECT id FROM data_manager.jobs`).map((row) => String(row.id)),
    );
    const catalog = join(root, "data/.transitous-catalog");
    let posts = 0;
    if (phase === "git")
      mkdirSync(join(catalog, ".git"), { recursive: true }); // Actual git fails locally; no upstream.
    else {
      const tokenFile = join(root, "proposal-token");
      writeFileSync(tokenFile, "p".repeat(43), { mode: 0o600 });
      resetOpsClient(
        new OpsClient({
          baseUrl: "http://127.0.0.1:4300",
          tokenFile,
          fetch: async (_url, options) => {
            if (options?.method === "GET")
              return Response.json({
                version: 1,
                requestId: new Headers(options.headers).get("x-ops-request-id"),
                ok: true,
                result: { versions: [1, 2] },
              });
            const request = JSON.parse(String(options?.body));
            if (request.operation.kind === "transitousLock.inspect")
              return Response.json({
                version: 1,
                requestId: request.requestId,
                ok: true,
                result: {
                  execution: "sync",
                  kind: request.operation.kind,
                  value: { active: null, proposed: null },
                },
              });
            posts++;
            throw Error("Synthetic proposal response lost after attempted POST");
          },
        }),
      );
    }
    const cron = proposalCron(
      phase === "proposal"
        ? {
            resolveBumpCandidate: async () => ({
              branch: "main",
              ref: "main@" + "a".repeat(40),
              transitousSha: "a".repeat(40),
              transitlandAtlasSha: "b".repeat(40),
            }),
          }
        : {},
    );
    try {
      await expect(cron.runAutoBumpNow()).rejects.toThrow();
      const rows = (
        await rawSql`SELECT * FROM data_manager.jobs WHERE kind='transit-proposal'`
      ).filter((row) => !before.has(String(row.id)));
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      expect(row.status).toBe("interrupted");
      expect(row.finished_at).toBeNull();
      if (phase === "git") expect(row.metadata.catalogPreflight.state).toBe("git-fetch-attempted");
      else {
        expect(posts).toBe(1);
        expect(row.metadata.retainedOps).toHaveLength(1);
        expect(row.metadata.retainedOps[0].state).toBe("attempted");
        expect(row.metadata.retainedOps[0].operationKey).toMatch(/^opk1_/);
        expect(row.metadata.retainedOps[0].fingerprint).toMatch(/^[a-f0-9]{64}$/);
      }
      await reconcileLegacyCatalogPreflightRejections(rawSql);
      const [after] = await rawSql`SELECT * FROM data_manager.jobs WHERE id=${row.id}`;
      expect(after?.metadata).toEqual(row.metadata);
      expect(after?.finished_at).toBeNull();
      await expect(fence.withAdmission(async () => "must not admit")).rejects.toMatchObject({
        statusCode: 409,
      });
    } finally {
      cron.stop();
      resetOpsClient();
      rmSync(catalog, { recursive: true, force: true });
      const ids = (await rawSql`SELECT id FROM data_manager.jobs`)
        .map((row) => String(row.id))
        .filter((id) => !before.has(id));
      for (const id of ids) await rawSql`DELETE FROM data_manager.jobs WHERE id=${id}`;
    }
  },
  30000,
);

import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { registerApi } from "../../api";
import { registerAuth } from "../../auth";
import { resolveOperationsProfile } from "../transitous/operations-profile";
import { createDataExecutionDispatcher } from "./dispatch";
import { createDataExecutionReceiver } from "./receiver";
import { createDataExecutionRuntime } from "./runtime";
import { createPostgresDataExecutionStore } from "./store";

async function legacyFixture(held = false, realDispatch = false) {
  let workerError: unknown;
  const journal = control.createDataExecutionControlJournal(installation, rawSql);
  const store = createPostgresDataExecutionStore(rawSql, {
    controlJournal: journal,
    configurationFence: fence,
  });
  let dispatches = 0,
    release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime = createDataExecutionRuntime({
    store,
    dispatch: async (input, context) => {
      dispatches++;
      if (held) await gate;
      if (realDispatch) {
        try {
          return await dispatcher.dispatch(input, context);
        } catch (error) {
          workerError = error;
          throw error;
        }
      }
      if (input.kind !== "transit-sync") throw Error("This admission fixture selects transit only");
      return {
        kind: input.kind,
        finalStatus: "ok",
        sourceRevision: "synthetic-public",
        countries: input.countries,
      };
    },
  });
  const singleFlight = createSingleFlightController({ db, admissionSql: rawSql }),
    policy = resolveOperationsProfile({ countries: ["de", "ch"] });
  const dispatcher = createDataExecutionDispatcher({
    dataDir: join(root, "data"),
    state: new StateStore(join(root, "data")),
    sql: rawSql,
    singleFlight,
    operationsPolicy: policy,
    runHardlinks: async () => {
      throw Error("No hardlink operation");
    },
  });
  const receiver = createDataExecutionReceiver({
    runtime,
    installation,
    configurationFence: fence,
    dispatcher,
    operationsPolicy: policy,
  });
  const app = Fastify();
  registerAuth(app, "fix1-synthetic-token", { executionReceiver: () => receiver });
  registerApi(app, {
    dataDir: join(root, "data"),
    singleFlight,
    operationsPolicy: policy,
    executionReceiver: receiver,
    searchIndexSql: rawSql,
  });
  const before = new Set(
    (await rawSql`SELECT id FROM data_manager.jobs`).map((row) => String(row.id)),
  );
  return {
    app,
    runtime,
    receiver,
    store,
    release,
    dispatches: () => dispatches,
    workerError: () => workerError,
    async close() {
      release();
      await runtime.close();
      app.server.closeAllConnections();
      await app.close();
      journal.close();
      const created = (await rawSql`SELECT id FROM data_manager.jobs`)
        .map((row) => String(row.id))
        .filter((id) => !before.has(id));
      for (const id of created) await rawSql`DELETE FROM data_manager.jobs WHERE id=${id}`;
    },
  };
}
const headers = { authorization: "Bearer fix1-synthetic-token" };
it.skipIf(!enabled)(
  "I1 preserves the documented duplicate response for an original pre-upgrade job",
  async () => {
    const f = await legacyFixture(),
      key = "fix1-v1-" + randomUUID(),
      id = randomUUID();
    try {
      await rawSql`INSERT INTO data_manager.jobs(id,kind,status,finished_at,idempotency_key) VALUES(${id},'transitous-sync','ok',now(),${key})`;
      const response = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: { countries: ["de"], idempotencyKey: key },
      });
      expect(response.statusCode).toBe(409);
      expect(response.json()).toEqual({
        ok: false,
        reason: "duplicate-idempotency-key",
        existingJobId: id,
      });
      expect(f.dispatches()).toBe(0);
    } finally {
      await f.close();
    }
  },
);
it.skipIf(!enabled)(
  "I1 observes the original completed transit identity and actor after keyed retries",
  async () => {
    const f = await legacyFixture();
    try {
      const body = {
        countries: ["de"],
        idempotencyKey: "fix1-completed-" + randomUUID(),
        triggeredBy: "api:user:synthetic-admin",
      };
      const first = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: body,
      });
      expect(first.statusCode, first.body).toBe(202);
      const id = first.json().jobId as string;
      await expect
        .poll(async () => (await f.store.inspect(id))?.status.status, { timeout: 15000 })
        .toBe("ok");
      const original = await f.store.inspect(id);
      const retry = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: body,
      });
      expect(retry.statusCode, retry.body).toBe(202);
      expect(retry.json().jobId).toBe(id);
      expect(f.dispatches()).toBe(1);
      const changedActor = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: { ...body, triggeredBy: "other:actor" },
      });
      expect(changedActor.statusCode).toBe(409);
      expect((await f.store.inspect(id))?.execution).toEqual(original?.execution);
      expect((await f.store.inspect(id))?.triggeredBy).toBe(body.triggeredBy);
      const changed = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: { ...body, countries: ["ch"] },
      });
      expect(changed.statusCode).toBe(409);
      expect(f.dispatches()).toBe(1);
    } finally {
      await f.close();
    }
  },
  45000,
);
it.skipIf(!enabled)(
  "I1 serializes simultaneous first admission, keeps no-key calls distinct and expires only completed legacy aliases after 24 hours",
  async () => {
    const f = await legacyFixture(true);
    try {
      const body = {
        countries: ["de"],
        idempotencyKey: "fix1-race-" + randomUUID(),
        triggeredBy: "synthetic:actor",
      };
      const responses = await Promise.all(
        [1, 2].map(() =>
          f.app.inject({ method: "POST", url: "/transit/sync", headers, payload: body }),
        ),
      );
      expect(responses.map((r) => r.statusCode)).toEqual([202, 202]);
      const id = responses[0]!.json().jobId as string;
      expect(responses[1]!.json().jobId).toBe(id);
      f.release();
      await expect
        .poll(async () => (await f.store.inspect(id))?.status.status, { timeout: 15000 })
        .toBe("ok");
      await rawSql`UPDATE data_manager.jobs SET started_at=now()-interval '23 hours 59 minutes' WHERE id=${id}`;
      expect(
        (
          await f.app.inject({ method: "POST", url: "/transit/sync", headers, payload: body })
        ).json().jobId,
      ).toBe(id);
      await rawSql`UPDATE data_manager.jobs SET started_at=now()-interval '24 hours 1 minute' WHERE id=${id}`;
      const afterWindow = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: body,
      });
      expect(afterWindow.statusCode, afterWindow.body).toBe(202);
      expect(afterWindow.json().jobId).not.toBe(id);
      await expect
        .poll(async () => (await f.store.inspect(afterWindow.json().jobId))?.status.status, {
          timeout: 15000,
        })
        .toBe("ok");
      const noKeyIds: string[] = [];
      for (let i = 0; i < 2; i++) {
        const response = await f.app.inject({
          method: "POST",
          url: "/transit/sync",
          headers,
          payload: { countries: ["de"], triggeredBy: "synthetic:no-key" },
        });
        expect(response.statusCode, response.body).toBe(202);
        noKeyIds.push(response.json().jobId);
        await expect
          .poll(async () => (await f.store.inspect(response.json().jobId))?.status.status, {
            timeout: 15000,
          })
          .toBe("ok");
      }
      expect(new Set(noKeyIds).size).toBe(2);
      expect(f.dispatches()).toBe(4);
    } finally {
      await f.close();
    }
  },
  45000,
);
it.skipIf(!enabled)(
  "I1 resolves a lost actual 202 and concurrent keyed retries without another dispatch",
  async () => {
    const f = await legacyFixture(true);
    let drop = true;
    f.app.addHook("onSend", async (request, reply, payload) => {
      if (
        request.method === "POST" &&
        request.url === "/transit/sync" &&
        reply.statusCode === 202 &&
        drop
      ) {
        drop = false;
        reply.raw.destroy();
      }
      return payload;
    });
    await f.app.listen({ host: "127.0.0.1", port: 0 });
    const address = f.app.server.address();
    if (!address || typeof address === "string") throw Error("Actual receiver endpoint missing");
    const base = `http://127.0.0.1:${address.port}`,
      body = {
        countries: ["de"],
        idempotencyKey: "fix1-lost-" + randomUUID(),
        triggeredBy: "manual:admin:synthetic",
      };
    const send = () =>
      fetch(base + "/transit/sync", {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    try {
      await expect(send()).rejects.toThrow();
      await expect.poll(f.dispatches, { timeout: 15000 }).toBe(1);
      const original = (await f.store.listUnsettled()).find(
        (row) => row.status.kind === "transit-sync",
      );
      if (!original) throw Error("Original retained admission missing");
      const retries = await Promise.all([send(), send()]);
      const replies = await Promise.all(
        retries.map(async (response) => ({ code: response.status, body: await response.json() })),
      );
      expect(replies).toEqual(
        replies.map(() => ({
          code: 202,
          body: { ok: true, jobId: original.status.id, status: "started" },
        })),
      );
      expect(f.dispatches()).toBe(1);
      const changedKey = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: { ...body, idempotencyKey: body.idempotencyKey + "-other" },
      });
      expect(changedKey.statusCode).toBe(409);
      expect((await f.store.inspect(original.status.id))?.execution).toEqual(original.execution);
      f.release();
      await expect
        .poll(async () => (await f.store.inspect(original.status.id))?.status.status, {
          timeout: 15000,
        })
        .toBe("ok");
      const afterCompletion = await send();
      expect((await afterCompletion.json()).jobId).toBe(original.status.id);
      expect(f.dispatches()).toBe(1);
    } finally {
      await f.close();
    }
  },
  45000,
);
it.skipIf(!enabled)(
  "observes the original reviewed transit intent after loss of the API preview cache without another dispatch",
  async () => {
    const f = await legacyFixture(true),
      key = `reviewed-observe-${randomUUID()}`;
    try {
      const preflight = {
        preflightId: randomUUID(),
        fingerprint: "a".repeat(64),
        sourceFingerprint: "b".repeat(64),
        expiresAt: new Date(Date.now() + 300000).toISOString(),
      };
      // This held-worker fixture proves SQL identity/observation, not production
      // capacity validation or downloads. The real dispatcher is checked separately.
      const admitted = await f.receiver.admitLocal(
        { kind: "transit-sync", countries: ["de"], preflight },
        { legacyTransitKey: key, triggeredBy: "fixture-reviewer" },
      );
      const body = {
        countries: ["DE"],
        idempotencyKey: key,
        preflightId: preflight.preflightId,
        fingerprint: preflight.fingerprint,
        triggeredBy: "fixture-reviewer",
      };
      const retry = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: body,
      });
      expect(retry.statusCode).toBe(202);
      expect(retry.json().jobId).toBe(admitted.id);
      const [row] =
        await rawSql`SELECT count(*)::int AS count FROM data_manager.jobs WHERE idempotency_key=${key}`;
      expect(row?.count).toBe(1);
      const wrong = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: { ...body, fingerprint: "c".repeat(64) },
      });
      expect(wrong.statusCode).toBe(409);
      const actor = await f.app.inject({
        method: "POST",
        url: "/transit/sync",
        headers,
        payload: { ...body, triggeredBy: "another-reviewer" },
      });
      expect(actor.statusCode).toBe(409);
      expect(f.dispatches()).toBeLessThanOrEqual(1);
    } finally {
      await f.close();
    }
  },
  30000,
);
it.skipIf(!enabled)(
  "rechecks reviewed sources in the actual durable dispatcher before any pipeline effects",
  async () => {
    const { initializeManagedCatalogPins } = await import("@openmapx/core/catalog-pins");
    const { buildOpsAgentServer } = await import("../../../../../apps/ops-agent/src/server");
    const { createUnavailableRuntime } = await import("../../../../../apps/ops-agent/src/runtime");
    const { createTransitousLockRuntime } = await import(
      "../../../../../apps/ops-agent/src/transitous-lock-runtime"
    );
    const { createRegistryResourcePolicy, denyAllTrustedOpsData } = await import(
      "../../../../../apps/ops-agent/src/policy"
    );
    const agent = control.openControlInstallation({
      infraDir: root,
      role: "ops-agent",
      serviceIds: ["motis"],
    });
    const f = await legacyFixture(true, true),
      envNames = [
        "MOTIS_SLOT_MEMORY_GB",
        "MOTIS_SLOT_CPU",
        "MOTIS_FILE_DESCRIPTOR_LIMIT",
        "MOTIS_BUILD_TIMEOUT_HOURS",
        "TRANSITOUS_FEEDS_OVERLAY_PATH",
      ] as const,
      old = envNames.map((name) => process.env[name]);
    const token = Buffer.alloc(32, 5).toString("base64url");
    const server = buildOpsAgentServer({
      tokens: { api: Buffer.alloc(32, 6).toString("base64url"), "data-manager": token },
      controlInstallation: agent,
      runtime: createTransitousLockRuntime(createUnavailableRuntime(), { rootDir: repository }),
      resourcePolicy: createRegistryResourcePolicy({
        serviceIds: ["motis"],
        integrationIds: [],
        trustedData: denyAllTrustedOpsData,
      }),
    });
    try {
      writeFileSync(
        join(root, "transitous.lock.json"),
        JSON.stringify({
          ref: `main@${"a".repeat(40)}`,
          submodules: {},
          lockedAt: "2026-10-23T00:00:00.000Z",
          lockedBy: "fixture",
        }),
      );
      const commit = "b".repeat(40);
      writeFileSync(
        join(root, "gbfs-catalog.lock.json"),
        JSON.stringify({
          schemaVersion: 1,
          source: "mobilitydata-gbfs",
          commit,
          url: `https://raw.githubusercontent.com/MobilityData/gbfs/${commit}/systems.csv`,
          sha256: "c".repeat(64),
          lockedAt: "2026-10-23T00:00:00.000Z",
          lockedBy: "fixture",
        }),
      );
      await initializeManagedCatalogPins({ rootDir: repository, installation: agent });
      const baseUrl = await server.listen({ host: "127.0.0.1", port: 0 }),
        tokenFile = join(root, "preview-token");
      writeFileSync(tokenFile, token, { mode: 0o600 });
      resetOpsClient(new OpsClient({ baseUrl, tokenFile }));
      for (const [name, value] of Object.entries({
        MOTIS_SLOT_MEMORY_GB: "16",
        MOTIS_SLOT_CPU: "4",
        MOTIS_FILE_DESCRIPTOR_LIMIT: "65536",
        MOTIS_BUILD_TIMEOUT_HOURS: "12",
        TRANSITOUS_FEEDS_OVERLAY_PATH: join(root, "preview-overlay.json"),
      }))
        process.env[name] = value;
      const catalog = join(root, "data/.transitous-catalog");
      mkdirSync(join(catalog, "feeds"), { recursive: true });
      mkdirSync(join(catalog, ".git"), { recursive: true });
      writeFileSync(
        join(catalog, "feeds/de.json"),
        JSON.stringify({
          sources: [
            { name: "demo", spec: "gtfs", type: "http", url: "https://example.test/demo.zip" },
          ],
        }),
      );
      const preview = await f.app.inject({
        method: "POST",
        url: "/transit/sync/preflight",
        headers,
        payload: { countries: ["de"] },
      });
      expect(preview.statusCode, preview.body).toBe(200);
      expect(preview.json().result.ok, preview.body).toBe(true);
      const reviewed = preview.json(),
        response = await f.app.inject({
          method: "POST",
          url: "/transit/sync",
          headers,
          payload: {
            countries: ["de"],
            preflightId: reviewed.preflightId,
            fingerprint: reviewed.fingerprint,
            idempotencyKey: `reviewed-worker-${randomUUID()}`,
          },
        });
      expect(response.statusCode, response.body).toBe(202);
      const id = response.json().jobId;
      writeFileSync(join(catalog, "feeds/de.json"), JSON.stringify({ sources: [] }));
      f.release();
      await expect
        .poll(async () => (await f.runtime.inspect(id))?.status, { timeout: 15000 })
        .toBe("error");
      expect(f.workerError()).toMatchObject({ code: "preflight_stale" });
      expect(f.dispatches()).toBe(1);
      expect((await f.runtime.inspect(id))?.publication).toBe("not_started");
      expect(
        (await import("node:fs")).existsSync(join(root, "data/.admin-target-control/locks/motis")),
      ).toBe(false);
    } finally {
      f.release();
      await f.close();
      await server.close();
      control.closeControlInstallation(agent);
      resetOpsClient();
      envNames.forEach((name, n) => {
        if (old[n] === undefined) delete process.env[name];
        else process.env[name] = old[n];
      });
    }
  },
  45000,
);
