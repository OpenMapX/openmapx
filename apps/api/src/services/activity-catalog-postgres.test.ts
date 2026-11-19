/** Actual SQL Activity projection; admitted rows here are inert and never dispatch. */
import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createDataExecutionControlJournal,
  openControlInstallation,
  provisionControlDirectories,
} from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { expect, it, vi } from "vitest";
import { createPostgresDataExecutionStore } from "../../../../services/data-manager/src/jobs/execution/store";
import { createMigratedPostgresFixture } from "../test/postgres-fixture";

const state = vi.hoisted(() => ({
  fixture: null as Awaited<ReturnType<typeof createMigratedPostgresFixture>> | null,
}));
vi.mock("../db", () => ({
  get db() {
    if (!state.fixture) throw Error("Owned database not installed");
    return state.fixture.db;
  },
}));
it.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "offers exact durable catalog jobs for cancellation in both Activity list and detail",
  async () => {
    const fixture = await createMigratedPostgresFixture();
    state.fixture = fixture;
    const root = mkdtempSync(join(tmpdir(), "omx-activity-catalog-"));
    try {
      mkdirSync(join(root, "data"), { mode: 0o700 });
      await provisionControlDirectories(root);
      const installation = openControlInstallation({
          infraDir: root,
          role: "data-manager",
          serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
        }),
        store = createPostgresDataExecutionStore(fixture.sql, {
          controlJournal: createDataExecutionControlJournal(installation, fixture.sql),
        }),
        deadline = Date.now() + 60000,
        proposalId = randomUUID();
      const inputs = [
        { kind: "catalog.validate" as const, proposalId, countries: ["de"] },
        {
          kind: "catalog.activate" as const,
          proposalId,
          validationId: randomUUID(),
          expectedGenerationId: null,
          diffDigest: "d".repeat(64),
          acknowledgeLicenseChanges: true,
        },
      ];
      const { listActivityJobs, getActivityJob } = await import("./activity-jobs");
      for (const input of inputs) {
        const { record } = await store.admit(input, {
          operationKey: createControlRootOperationKey({
            notAfter: deadline,
            nonce: randomBytes(16),
          }),
          requestedDeadlineAt: deadline,
        });
        const listed = await listActivityJobs({ filter: "active", limit: 100, offset: 0 });
        expect(listed.jobs.find((job) => job.id === record.status.id)).toMatchObject({
          source: "data-manager",
          type: input.kind,
          cancelable: true,
        });
        expect(await getActivityJob(record.status.id, "data-manager")).toMatchObject({
          cancelable: true,
        });
        // One catalog job runs at a time; the next one is admitted once this row is gone.
        await fixture.sql`DELETE FROM data_manager.jobs WHERE id=${record.status.id}`;
      }
    } finally {
      state.fixture = null;
      await fixture.stop();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
