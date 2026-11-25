/**
 * The administrator an API route starts a data job for, end to end: the real
 * API route proxies to a data-manager whose receiver, runtime and store write
 * the real `data_manager.job` row, and deleting the account clears it there
 * through the foreign key.
 */
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  createDataExecutionControlJournal,
  openControlInstallation,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
import { eq } from "drizzle-orm";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { registerApi } from "../../../../../services/data-manager/src/api.js";
import { registerAuth } from "../../../../../services/data-manager/src/auth.js";
import { createDataConfigurationMaintenance } from "../../../../../services/data-manager/src/jobs/execution/configuration-maintenance.js";
import { createDataExecutionReceiver } from "../../../../../services/data-manager/src/jobs/execution/receiver.js";
import { createDataExecutionRuntime } from "../../../../../services/data-manager/src/jobs/execution/runtime.js";
import { createPostgresDataExecutionStore } from "../../../../../services/data-manager/src/jobs/execution/store.js";
import { resolveOperationsProfile } from "../../../../../services/data-manager/src/jobs/transitous/operations-profile.js";
import { transitSourceRevision } from "../../../../../services/data-manager/src/transit-sources.js";
import { db, sql } from "../../db/index.js";
import { user } from "../../db/schema.js";
import { dataManagerTokenFile } from "../../test/data-manager-token";

const session = vi.hoisted(() => ({ userId: "" }));
vi.mock("../../utils/require-admin.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../utils/require-admin.js")>()),
  tryAdminSession: vi.fn(async () =>
    session.userId ? { user: { id: session.userId, role: "admin" } } : null,
  ),
}));

const TOKENS = {
  api: "synthetic-actor-api-token-0123456789",
  "ops-agent": "synthetic-actor-agent-token-0123456789",
  "host-cli": "synthetic-actor-cli-token-0123456789",
};

describe.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "data job actor from an API route",
  () => {
    let root = "";
    let close = async () => {};

    beforeAll(async () => {
      root = mkdtempSync(join(tmpdir(), "omx-data-job-actor-"));
      const dataDir = join(root, "data");
      mkdirSync(join(dataDir, ".transitous-catalog", "feeds"), { recursive: true });
      mkdirSync(join(dataDir, ".transitous-catalog", ".git"), { recursive: true });
      writeFileSync(
        join(dataDir, ".transitous-catalog", "feeds", "de.json"),
        JSON.stringify({
          sources: [{ name: "catalog-feed", url: "https://catalog.example/f.zip" }],
        }),
      );
      await provisionControlDirectories(root);
      const installation = openControlInstallation({
          infraDir: root,
          role: "data-manager",
          serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
        }),
        fence = createDataConfigurationMaintenance(sql, installation);
      await fence.startup();
      const runtime = createDataExecutionRuntime({
        store: createPostgresDataExecutionStore(sql, {
          controlJournal: createDataExecutionControlJournal(installation, sql),
          configurationFence: fence,
        }),
        // The job's work is not what this test observes.
        dispatch: async () => {
          throw Error("Synthetic transit sync stops before any work");
        },
        openSql: () => ({ sql, close: async () => {} }),
      });
      const operationsPolicy = resolveOperationsProfile({ countries: ["de"] });
      const dataManager = Fastify();
      registerAuth(dataManager, TOKENS);
      registerApi(dataManager, {
        dataDir,
        operationsPolicy,
        executionReceiver: createDataExecutionReceiver({
          runtime,
          installation,
          configurationFence: fence,
          dispatcher: {} as never,
          operationsPolicy,
        }),
      });
      const address = await dataManager.listen({ host: "127.0.0.1", port: 0 });
      vi.stubEnv("DATA_MANAGER_URL", address);
      vi.stubEnv("DATA_MANAGER_TOKEN_FILE", dataManagerTokenFile(TOKENS.api));
      close = async () => {
        await dataManager.close();
        await runtime.close();
        closeControlInstallation(installation);
      };
    }, 60_000);

    afterAll(async () => {
      await close();
      vi.unstubAllEnvs();
      rmSync(root, { recursive: true, force: true });
    });

    it("records the administrator, and deleting the account clears it from the job", async () => {
      // The session is mocked, so the account need not hold the administrator
      // role, which would bring the last-administrator guard into play.
      const userId = randomUUID();
      await db.insert(user).values({
        id: userId,
        name: "Data job actor",
        email: `${userId}@example.test`,
        updatedAt: new Date(),
      });
      session.userId = userId;
      const { dataManagerRoute } = await import("../data-manager.js");
      const api = Fastify();
      await api.register(dataManagerRoute, { prefix: "/api" });
      let jobId = "";
      try {
        const dataDir = join(root, "data");
        const response = await api.inject({
          method: "POST",
          url: "/api/data-manager/transit/sources",
          payload: {
            region: "de",
            name: "operator-feed",
            url: "https://operator.example/feed.zip",
            license: { spdxIdentifier: "CC-BY-4.0", attribution: "Operator" },
            expectedSourceRevision: transitSourceRevision({
              catalogDir: join(dataDir, ".transitous-catalog"),
              overlayPath: join(dataDir, "overrides/feeds-overlay.json"),
            }),
          },
        });
        expect(response.statusCode, response.body).toBe(202);
        jobId = (response.json() as { jobId: string }).jobId;
        expect(
          await sql`SELECT trigger, triggered_by_user_id FROM data_manager.job WHERE id = ${jobId}`,
        ).toEqual([{ trigger: "api", triggered_by_user_id: userId }]);

        await db.delete(user).where(eq(user.id, userId));

        expect(
          await sql`SELECT trigger, triggered_by_user_id FROM data_manager.job WHERE id = ${jobId}`,
        ).toEqual([{ trigger: "api", triggered_by_user_id: null }]);
      } finally {
        await api.close();
        session.userId = "";
        await db.delete(user).where(eq(user.id, userId));
        if (jobId) await sql`DELETE FROM data_manager.job WHERE id = ${jobId}`;
      }
    }, 60_000);
  },
);
