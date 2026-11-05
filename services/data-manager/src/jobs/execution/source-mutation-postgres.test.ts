import { randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, it } from "vitest";
import { transitSourceRevision } from "../../transit-sources.js";
import { resolveOperationsProfile } from "../transitous/operations-profile.js";
import { readFeedOverlay, writeFeedOverlayAtomic } from "../transitous-feeds-overlay.js";
import { createDataExecutionRuntime } from "./runtime.js";
import { publishOwnedTransitSourceMutation } from "./source-mutation.js";
import { createPostgresDataExecutionStore } from "./store.js";

it.skipIf(process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1")(
  "publishes source intent only under its original durable sync root and preserves it on replay",
  async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned migrated PostgreSQL required");
    const sql = postgres(url, { max: 4 });
    drizzle(sql);
    const root = mkdtempSync(join(tmpdir(), "omx-source-owner-")),
      dataRoot = join(root, "data"),
      catalogDir = join(dataRoot, ".transitous-catalog"),
      overlayPath = join(dataRoot, "overrides/feeds-overlay.json");
    mkdirSync(join(catalogDir, "feeds"), { recursive: true });
    mkdirSync(join(dataRoot, "overrides"));
    writeFileSync(join(catalogDir, "feeds/de.json"), JSON.stringify({ sources: [] }));
    writeFeedOverlayAtomic(overlayPath, {
      version: 3,
      sources: [
        {
          spec: "gtfs",
          type: "http",
          origin: "operator",
          region: "de",
          name: "local",
          url: "https://operator.example.test/feed.zip",
          license: { spdxIdentifier: "CC0-1.0", attribution: "Synthetic operator" },
        },
      ],
      patches: [],
      quarantine: [],
    });
    await control.provisionControlInstallation(root);
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal });
    function deferred() {
      let resolve!: () => void;
      const promise = new Promise<void>((done) => {
        resolve = done;
      });
      return { promise, resolve };
    }
    const held = deferred(),
      started = deferred();
    let writes = 0;
    const input = {
      kind: "transit-sync" as const,
      countries: ["de"],
      sourceMutation: {
        action: "disable" as const,
        sourceId: "operator:de:local",
        expectedSourceRevision: transitSourceRevision({ catalogDir, overlayPath }),
      },
    };
    const runtime = createDataExecutionRuntime({
      store,
      dispatch: async (value, context) => {
        if (value.kind === "download-fonts") {
          started.resolve();
          await held.promise;
          return { kind: "download-fonts", completed: true };
        }
        if (value.kind !== "transit-sync") throw Error("Unexpected fixture input");
        const before = readFileSync(overlayPath);
        await expect(
          publishOwnedTransitSourceMutation(
            { ...value, sourceMutation: { ...input.sourceMutation, action: "remove" } },
            context,
            resolveOperationsProfile({ countries: ["de"] }),
            dataRoot,
          ),
        ).rejects.toThrow("Original transit mutation identity");
        expect(readFileSync(overlayPath)).toEqual(before);
        await publishOwnedTransitSourceMutation(
          value,
          context,
          resolveOperationsProfile({ countries: ["de"] }),
          dataRoot,
        );
        writes++;
        return {
          kind: "transit-sync",
          sourceRevision: "synthetic-pinned-catalog",
          countries: ["de"],
          finalStatus: "ok",
        };
      },
    });
    const deadline = Date.now() + 60000,
      key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
    let id: string | undefined;
    const keys = [key],
      sourceReservationId = randomUUID();
    try {
      const fontKey = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        blockedKey = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
      keys.push(fontKey, blockedKey);
      const competing = await runtime.admit(
        { kind: "download-fonts" },
        { operationKey: fontKey, requestedDeadlineAt: deadline },
      );
      await started.promise;
      const originalBytes = readFileSync(overlayPath);
      await expect(
        runtime.admit(input, { operationKey: blockedKey, requestedDeadlineAt: deadline }),
      ).rejects.toThrow();
      expect(writes).toBe(0);
      expect(readFileSync(overlayPath)).toEqual(originalBytes);
      held.resolve();
      await expect
        .poll(async () => (await runtime.inspect(competing.id))?.status, { timeout: 15000 })
        .toBe("ok");
      await sql`INSERT INTO data_manager.jobs(id,kind,status,metadata) VALUES (${sourceReservationId},'transit-source-disable','running',${JSON.stringify({ action: "disable", sourceId: "operator:de:local" })}::text::jsonb)`;
      const admitted = await runtime.admit(input, {
        operationKey: key,
        requestedDeadlineAt: deadline,
        sourceJobId: sourceReservationId,
      });
      id = admitted.id;
      await expect
        .poll(async () => (await runtime.inspect(id!))?.status, { timeout: 15000 })
        .toBe("ok");
      expect(readFeedOverlay(overlayPath)?.patches).toEqual([
        { sourceId: "operator:de:local", skip: true },
      ]);
      expect(
        (await sql`SELECT status FROM data_manager.jobs WHERE id=${sourceReservationId}`)[0]
          ?.status,
      ).toBe("ok");
      const bytes = readFileSync(overlayPath);
      expect(
        (await runtime.admit(input, { operationKey: key, requestedDeadlineAt: deadline })).id,
      ).toBe(id);
      expect(writes).toBe(1);
      expect(readFileSync(overlayPath)).toEqual(bytes);
      for (const action of ["enable", "remove"] as const) {
        const nextKey = createControlRootOperationKey({
          notAfter: deadline,
          nonce: randomBytes(16),
        });
        keys.push(nextKey);
        const next = {
          ...input,
          sourceMutation: {
            ...input.sourceMutation,
            action,
            expectedSourceRevision: transitSourceRevision({ catalogDir, overlayPath }),
          },
        };
        const status = await runtime.admit(next, {
          operationKey: nextKey,
          requestedDeadlineAt: deadline,
        });
        await expect
          .poll(async () => (await runtime.inspect(status.id))?.status, { timeout: 15000 })
          .toBe("ok");
        const observed = await store.inspect(status.id);
        expect(observed?.input).toEqual(next);
        if (action === "enable")
          expect(readFeedOverlay(overlayPath)).toMatchObject({
            sources: [
              {
                url: "https://operator.example.test/feed.zip",
                license: { spdxIdentifier: "CC0-1.0", attribution: "Synthetic operator" },
              },
            ],
            patches: [{ sourceId: "operator:de:local", skip: false }],
          });
        else
          expect(readFeedOverlay(overlayPath)).toEqual({
            version: 3,
            sources: [],
            patches: [],
            quarantine: [],
          });
      }
      expect(writes).toBe(3);
    } finally {
      held.resolve();
      await runtime.close();
      await sql`DELETE FROM data_manager.jobs WHERE operation_key IN ${sql(keys)} OR id=${sourceReservationId}`;
      journal.close();
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
  45000,
);
