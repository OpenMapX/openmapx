import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey } from "@openmapx/core/ops";
import { build } from "esbuild";
import postgres from "postgres";
import { afterAll, beforeAll, expect, it } from "vitest";
import { buildTransitousRunnerServer } from "../../../../../apps/transitous-runner/src/server";
import { createTransitousScriptRunner } from "../transitous/script-runner";
import { createDataExecutionRuntime } from "./runtime";
import { createPostgresDataExecutionStore } from "./store";

let recoveryBundleRoot: string, dmBundle: string, agentBundle: string;
beforeAll(async () => {
  recoveryBundleRoot = mkdtempSync(join(tmpdir(), "omx-dm-crash-bundle-"));
  dmBundle = join(recoveryBundleRoot, "dm.mjs");
  agentBundle = join(recoveryBundleRoot, "agent.mjs");
  for (const [entry, outfile, manifest] of [
    [
      "services/data-manager/src/jobs/execution/test-fixtures/dm-recovery-process.ts",
      dmBundle,
      "services/data-manager/package.json",
    ],
    [
      "apps/ops-agent/src/test-fixtures/data-owned-http-process.ts",
      agentBundle,
      "apps/ops-agent/package.json",
    ],
  ])
    await build({
      entryPoints: [resolve(entry!)],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      banner: {
        js: `import {createRequire as fixtureCreateRequire} from "node:module"; const require=fixtureCreateRequire(${JSON.stringify(resolve(manifest!))});`,
      },
    });
});
afterAll(() => {
  if (recoveryBundleRoot) rmSync(recoveryBundleRoot, { recursive: true, force: true });
});

function processPeer(file: string, initial: unknown, env: NodeJS.ProcessEnv = process.env) {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, [file], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + String(data)).slice(-6000);
  });
  const lines = createInterface({ input: child.stdout }),
    iterator = lines[Symbol.asyncIterator]();
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + "\n");
  async function next(type: string): Promise<Record<string, unknown>> {
    for (;;) {
      const line = await Promise.race([
        iterator.next(),
        new Promise<never>((_, reject) => {
          const timer = setTimeout(() => reject(Error(`Child ${type} timeout: ${stderr}`)), 15000);
          timer.unref();
        }),
      ]);
      if (line.done) throw Error(`Child exited before ${type}: ${stderr}`);
      const value = JSON.parse(line.value) as Record<string, unknown>;
      if (value.type === type) return value;
    }
  }
  send(initial);
  return {
    child,
    send,
    next,
    async kill() {
      child.kill("SIGKILL");
      await exited;
      lines.close();
    },
  };
}

it
  .skipIf(
    !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
      process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
  )
  .each(["agent", "python"] as const)(
  "I2 cancels the original live %s effect after a separate-process DM crash without worker completion",
  async (mode) => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Explicit owned DB required");
    const sql = postgres(url, { max: 4 }),
      root = mkdtempSync(join(tmpdir(), "omx-dm-active-crash-"));
    mkdirSync(join(root, "data"), { mode: 0o700 });
    await control.provisionControlInstallation(root);
    const token = "b".repeat(43),
      tokenFile = join(root, "token"),
      keyFile = join(root, "runner-key");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    writeFileSync(keyFile, "7".repeat(32), { mode: 0o600 });
    let agent: ReturnType<typeof processPeer> | undefined,
      dm: ReturnType<typeof processPeer> | undefined;
    let runner: ReturnType<typeof buildTransitousRunnerServer> | undefined;
    let id: string | undefined,
      posts = 0,
      cancels = 0,
      inspections = 0;
    let originalRunnerRequest: unknown;
    const runnerControls: unknown[] = [];
    const catalog = join(root, "catalog"),
      ready = join(catalog, "ready");
    let endpoint = "";
    try {
      if (mode === "agent") {
        agent = processPeer(agentBundle, { root, token, loseCancelResponse: true });
        const peer = await agent.next("ready");
        endpoint = `http://127.0.0.1:${peer.port}`;
      } else {
        mkdirSync(join(catalog, "src"), { recursive: true });
        writeFileSync(
          join(catalog, "src/garbage-collect.py"),
          "import os,time\nfrom pathlib import Path\nPath('ready').write_text(str(os.getpid()))\nwhile not Path('release').exists(): time.sleep(0.05)\n",
        );
        runner = buildTransitousRunnerServer({
          catalogDir: catalog,
          stagingDir: root,
          capabilityKey: Buffer.from("7".repeat(32)),
        });
        runner.addHook("onRequest", async (request) => {
          if (request.url === "/v1/run") posts++;
          if (request.url === "/v1/run/inspect") inspections++;
        });
        runner.addHook("preHandler", async (request) => {
          if (request.url === "/v1/run") originalRunnerRequest = request.body;
          else runnerControls.push(request.body);
        });
        runner.addHook("onSend", async (request, reply, payload) => {
          if (request.url === "/v1/run/cancel") {
            cancels++;
            if (cancels === 1) reply.raw.destroy();
          }
          return payload;
        });
        await runner.listen({ host: "127.0.0.1", port: 0 });
        const address = runner.server.address();
        if (!address || typeof address === "string") throw Error("Runner address missing");
        endpoint = `http://127.0.0.1:${address.port}`;
      }
      const env = {
        ...process.env,
        DATABASE_URL: url,
        OPS_AGENT_URL: endpoint,
        OPS_AGENT_TOKEN_FILE: tokenFile,
        TRANSITOUS_RUNNER_URL: endpoint,
        TRANSITOUS_RUNNER_CAPABILITY_KEY_FILE: keyFile,
      };
      const start = async (replacement: boolean) => {
        dm = processPeer(dmBundle, { root, token, mode, replacement }, env);
        const state = await dm.next("ready");
        return `http://127.0.0.1:${state.port}`;
      };
      let base = await start(false);
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
      const input = {
        countries: ["de"],
        idempotencyKey: "fix1-crash-" + randomUUID(),
        triggeredBy: "synthetic:operator",
      };
      if (mode === "agent") {
        const controller = new AbortController();
        const observation = fetch(base + "/transit/restart-motis", {
          method: "POST",
          headers: { authorization: headers.authorization },
          signal: controller.signal,
        }).catch((error) => error);
        id = String((await dm!.next("dispatch")).id);
        await agent!.next("effect");
        // The actual maintenance observer may disconnect while its child lives.
        controller.abort();
        await observation;
        agent!.send({ type: "probe" });
        expect((await agent!.next("probe")).state).toBe("running");
      } else {
        const admitted = await fetch(base + "/transit/sync", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        });
        expect(admitted.status).toBe(202);
        id = (await admitted.json()).jobId;
        await expect.poll(() => existsSync(ready), { timeout: 15000 }).toBe(true);
      }
      if (!id) throw Error("Original admission missing");
      const [original] = await sql`SELECT * FROM data_manager.jobs WHERE id=${id}`;
      if (!original) throw Error("Original row missing");
      const operationKey = String(original.operation_key),
        lock = join(root, "data/.admin-target-control/locks/motis");
      const inode = statSync(lock).ino;
      await dm!.kill();
      dm = undefined;
      // SIGKILL occurred while dispatcher awaited the independent child.
      const observations = join(root, "control-private/data-manager/observations");
      expect(existsSync(join(observations, `worker-${operationKey}.json`))).toBe(false);
      base = await start(true);
      if (mode === "python") {
        const retry = await fetch(base + "/transit/sync", {
          method: "POST",
          headers,
          body: JSON.stringify(input),
        });
        expect(retry.status).toBe(202);
        expect((await retry.json()).jobId).toBe(id);
      }
      const observer = await fetch(base + `/executions/${id}`, { headers });
      expect(observer.status).toBe(200);
      await observer.body?.cancel();
      if (mode === "python") {
        expect(cancels).toBe(0);
        process.kill(-Number(readFileSync(ready, "utf8")), 0);
      } else {
        agent!.send({ type: "probe" });
        expect((await agent!.next("probe")).state).toBe("running");
      }
      const canceled = await fetch(base + `/executions/${id}/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ operationKey, fingerprint: original.execution_fingerprint }),
      });
      expect(canceled.status, await canceled.text()).toBe(200);
      if (mode === "agent") {
        await agent!.next("aborted");
        expect((await agent!.next("cancel-response")).cancels).toBeGreaterThan(0);
      } else {
        await expect.poll(() => cancels, { timeout: 8000 }).toBeGreaterThan(0);
        const pid = Number(readFileSync(ready, "utf8"));
        await expect
          .poll(
            () => {
              try {
                process.kill(-pid, 0);
                return true;
              } catch (e) {
                if ((e as NodeJS.ErrnoException).code === "ESRCH") return false;
                throw e;
              }
            },
            { timeout: 8000 },
          )
          .toBe(false);
        await expect.poll(() => inspections, { timeout: 8000 }).toBeGreaterThan(0);
        expect(posts).toBe(1);
        expect(runnerControls.length).toBeGreaterThan(0);
        for (const request of runnerControls) expect(request).toEqual(originalRunnerRequest);
      }
      const [current] = await sql`SELECT * FROM data_manager.jobs WHERE id=${id}`;
      expect(current?.finished_at).toBeNull();
      expect(current?.status).toBe("cancel_pending");
      expect(current?.execution_state.publication).toBe("unknown");
      for (const key of [
        "id",
        "operation_key",
        "execution_fingerprint",
        "operation_fingerprint",
        "deadline_at",
        "execution_input",
        "triggered_by",
      ])
        expect(current?.[key]).toEqual(original[key]);
      expect(statSync(lock).ino).toBe(inode);
      expect(existsSync(join(observations, `worker-${operationKey}.json`))).toBe(false);
      dm!.send({ type: "probe" });
      expect((await dm!.next("probe")).dispatches).toBe(0);
      if (agent) {
        agent.send({ type: "probe" });
        const probe = await agent.next("probe");
        expect(probe.effects).toBe(1);
        expect(probe.forward).toBe(false);
        expect(probe.operationId).toBe(
          original.execution_children.find(
            (child: { phase: string }) => child.phase === "recover-primary",
          )?.proposedId,
        );
      }
    } finally {
      if (dm) await dm.kill();
      if (agent) await agent.kill();
      if (runner) {
        writeFileSync(join(catalog, "release"), "release");
        runner.server.closeAllConnections();
        await runner.close();
      }
      if (id) await sql`DELETE FROM data_manager.jobs WHERE id=${id}`;
      await sql.end();
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);

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
