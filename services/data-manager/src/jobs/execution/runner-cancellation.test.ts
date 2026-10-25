import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import postgres from "postgres";
import { expect, it } from "vitest";
import { buildTransitousRunnerServer } from "../../../../../apps/transitous-runner/src/server";
import { createTransitousScriptRunner } from "../transitous/script-runner";
import { createDataExecutionRuntime } from "./runtime";
import { createPostgresDataExecutionStore } from "./store";

it.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)(
  "cancels the actual retained remote Python process group after the cancellation response is lost",
  async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-data-runner-cancel-")),
      catalog = join(root, "catalog"),
      ready = join(catalog, "ready"),
      released = join(catalog, "release");
    mkdirSync(join(root, "data"), { mode: 0o700 });
    mkdirSync(join(catalog, "src"), { recursive: true });
    await control.provisionControlInstallation(root);
    writeFileSync(
      join(catalog, "src/garbage-collect.py"),
      "import os,time\nfrom pathlib import Path\nPath('ready').write_text(str(os.getpid()))\nwhile not Path('release').exists(): time.sleep(0.05)\n",
    );
    const key = Buffer.alloc(32, 7),
      runner = buildTransitousRunnerServer({
        catalogDir: catalog,
        stagingDir: root,
        capabilityKey: key,
      });
    let posts = 0,
      cancels = 0;
    runner.addHook("onSend", async (request, reply, payload) => {
      if (request.url === "/v1/run") posts++;
      if (request.url === "/v1/run/cancel") {
        cancels++;
        if (cancels === 1) reply.raw.destroy();
      }
      return payload;
    });
    await runner.listen({ host: "127.0.0.1", port: 0 });
    const address = runner.server.address();
    if (!address || typeof address === "string") throw Error("Runner endpoint missing");
    const run = createTransitousScriptRunner({
      baseUrl: `http://127.0.0.1:${address.port}`,
      capabilityKey: key,
    });
    const installation = control.openControlInstallation({
        infraDir: root,
        role: "data-manager",
        serviceIds: ["data-manager", "motis", "motis-feed-proxy", "motis-staging"],
      }),
      journal = control.createDataExecutionControlJournal(installation, sql),
      store = createPostgresDataExecutionStore(sql, { controlJournal: journal }),
      runtime = createDataExecutionRuntime({
        store,
        dispatch: async (_input, context) => {
          await run({ script: "garbage-collect" });
          context.signal.throwIfAborted();
          return {
            kind: "transit-sync",
            finalStatus: "ok",
            sourceRevision: "public-fixture",
            countries: ["de"],
          };
        },
      });
    let id: string | undefined, operationKey: string | undefined;
    try {
      const deadline = Date.now() + 60000;
      operationKey = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) });
      const admitted = await runtime.admit(
        { kind: "transit-sync", countries: ["de"] },
        { operationKey, requestedDeadlineAt: deadline },
      );
      id = admitted.id;
      await expect.poll(() => existsSync(ready), { timeout: 10000 }).toBe(true);
      const pid = Number(readFileSync(ready, "utf8"));
      const pending = await runtime.requestCancel({
        id,
        operationKey,
        fingerprint: admitted.fingerprint,
      });
      expect(pending.status).toBe("cancel_pending");
      await expect
        .poll(
          () => {
            try {
              process.kill(-pid, 0);
              return true;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
              throw error;
            }
          },
          { timeout: 2000 },
        )
        .toBe(false);
      await expect
        .poll(async () => (await store.inspect(id!))?.status.status, { timeout: 15000 })
        .toBe("canceled");
      expect((await store.inspect(id))?.status.publication).toBe("not_started");
      expect((await store.inspect(id))?.finishedAt).not.toBeNull();
      expect(posts).toBe(1);
      expect(cancels).toBeGreaterThanOrEqual(1);
      expect(existsSync(join(root, "data/.admin-target-control/locks/motis"))).toBe(false);
    } finally {
      writeFileSync(released, "release");
      await runtime.close();
      runner.server.closeAllConnections();
      await runner.close();
      if (!id && operationKey) id = (await store.lookup(operationKey))?.status.id;
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      journal.close();
      control.closeControlInstallation(installation);
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
