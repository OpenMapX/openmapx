import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import {
  createControlRootOperationKey,
  normalizeExecutionAdmission,
  OpsClient,
  opsOperationFingerprint,
} from "@openmapx/core/ops";
import { build } from "esbuild";
import Fastify from "fastify";
import postgres from "postgres";
import { expect, it } from "vitest";
import {
  createAdministrativeRuntime,
  createDefaultFixedCli,
} from "../../../../../apps/ops-agent/src/administrative-runtime";
import { openOpsJobJournal } from "../../../../../apps/ops-agent/src/journal";
import { createUnavailableRuntime } from "../../../../../apps/ops-agent/src/runtime";
import { buildOpsAgentServer } from "../../../../../apps/ops-agent/src/server";
import { registerApi } from "../../api";
import { registerAuth } from "../../auth";
import { StateStore } from "../../state";
import { resolveOperationsProfile } from "../transitous/operations-profile";
import { getSingleFlightController } from "../transitous/runtime";
import { createDataConfigurationMaintenance } from "./configuration-maintenance";
import { createDataExecutionDispatcher } from "./dispatch";
import { createDataExecutionReceiver } from "./receiver";
import { createDataExecutionRuntime } from "./runtime";
import { createPostgresDataExecutionStore } from "./store";

it.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)(
  "runs the actual fixed single data command through durable authenticated DM admission after a lost response",
  async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const root = mkdtempSync(join(tmpdir(), "omx-fixed-data-cli-")),
      infra = join(root, "infra/docker"),
      data = join(infra, "data");
    mkdirSync(data, { recursive: true, mode: 0o700 });
    await control.provisionControlInstallation(infra);
    const envKeys = [
        "OPENMAPX_ROOT_DIR",
        "DATA_MANAGER_URL",
        "DATA_MANAGER_AUTH_TOKEN",
        "OPENMAPTILES_FONTS_URL",
      ] as const,
      prior = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
    process.env.OPENMAPX_ROOT_DIR = root;
    const assets = join(root, "font-source/Test Font");
    mkdirSync(assets, { recursive: true });
    writeFileSync(join(assets, "0-255.pbf"), "synthetic-public-glyph");
    execFileSync("zip", ["-qr", join(root, "fonts.zip"), "Test Font"], {
      cwd: join(root, "font-source"),
    });
    const archive = readFileSync(join(root, "fonts.zip"));
    let downloads = 0;
    const fontServer = createServer((_req, res) => {
      downloads++;
      res.writeHead(200, { "content-type": "application/zip", "content-length": archive.length });
      res.end(archive);
    });
    await new Promise<void>((resolve) => fontServer.listen(0, "127.0.0.1", resolve));
    const fontAddress = fontServer.address();
    if (!fontAddress || typeof fontAddress === "string")
      throw Error("Synthetic font endpoint missing");
    process.env.OPENMAPTILES_FONTS_URL = `http://127.0.0.1:${fontAddress.port}/fonts.zip`;
    await build({
      entryPoints: [resolve("packages/cli/__tests__/fixtures/single-data-cli-process.ts")],
      outfile: join(root, "cli.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      tsconfig: resolve("packages/cli/tsconfig.json"),
      banner: {
        js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(resolve("packages/cli/package.json"))});`,
      },
    });
    const sql = postgres(url, { max: 4 }),
      dm = control.openControlInstallation({
        infraDir: infra,
        role: "data-manager",
        serviceIds: ["data-manager"],
      }),
      agentInstallation = control.openControlInstallation({
        infraDir: infra,
        role: "ops-agent",
        serviceIds: ["data-manager"],
      }),
      journal = control.createDataExecutionControlJournal(dm, sql),
      fence = createDataConfigurationMaintenance(sql, dm);
    await fence.startup();
    const store = createPostgresDataExecutionStore(sql, {
        controlJournal: journal,
        configurationFence: fence,
      }),
      singleFlight = getSingleFlightController(),
      operationsPolicy = resolveOperationsProfile({ countries: ["de"] }),
      dispatcher = createDataExecutionDispatcher({
        dataDir: data,
        state: new StateStore(data),
        sql,
        singleFlight,
        operationsPolicy,
        runHardlinks: async () => {
          throw Error("No generation grant");
        },
      }),
      runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch }),
      receiver = createDataExecutionReceiver({
        runtime,
        installation: dm,
        configurationFence: fence,
        dispatcher,
        operationsPolicy,
      });
    const app = Fastify();
    let admissions = 0;
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.method === "POST" && request.url === "/executions") {
        admissions++;
        if (admissions === 1) reply.raw.destroy();
      }
      return payload;
    });
    registerAuth(app, "synthetic-dm-token", { executionReceiver: () => receiver });
    registerApi(app, {
      dataDir: data,
      singleFlight,
      operationsPolicy,
      executionReceiver: receiver,
    });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address();
    if (!address || typeof address === "string") throw Error("DM address missing");
    process.env.DATA_MANAGER_URL = `http://127.0.0.1:${address.port}`;
    process.env.DATA_MANAGER_AUTH_TOKEN = "synthetic-dm-token";
    const agentJournal = await openOpsJobJournal(join(data, "ops-agent/jobs-v1.json")),
      agentRuntime = createAdministrativeRuntime(createUnavailableRuntime(), {
        rootDir: root,
        runFixedCli: createDefaultFixedCli(root, join(root, "agent.mjs")),
      }),
      token = "a".repeat(43),
      tokenFile = join(root, "api-token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    const agent = buildOpsAgentServer({
      runtime: agentRuntime,
      journal: agentJournal,
      controlInstallation: agentInstallation,
      tokens: { api: token, "data-manager": "d".repeat(43) },
      resourcePolicy: { allowGlobal: () => true, allowService: () => true },
    });
    await agent.listen({ host: "127.0.0.1", port: 0 });
    const agentAddress = agent.server.address();
    if (!agentAddress || typeof agentAddress === "string") throw Error("Agent address missing");
    const client = new OpsClient({ baseUrl: `http://127.0.0.1:${agentAddress.port}`, tokenFile });
    let id: string | undefined;
    try {
      const operation = { kind: "data.downloadFonts" as const },
        admittedAt = Date.now(),
        deadline = admittedAt + 60000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: randomBytes(16) }),
        normalized = normalizeExecutionAdmission({
          kind: operation.kind,
          operationKey: key,
          operationFingerprint: opsOperationFingerprint(operation),
          admittedAt,
          requestedDeadlineAt: deadline,
        });
      const admitted = await client.execute(operation, {
        operationKey: key,
        execution: { requestedDeadlineAt: deadline },
      });
      expect(admitted.execution).toBe("async");
      if (admitted.execution !== "async") throw Error("Async root required");
      id = admitted.operationId;
      try {
        await expect
          .poll(async () => await client.status(operation.kind, id!), {
            timeout: 25000,
            interval: 200,
          })
          .toMatchObject({ state: "succeeded", fingerprint: normalized.fingerprint });
      } catch (error) {
        console.info(
          "Synthetic fixed-command diagnostics",
          await client.events(id!),
          await client.status(operation.kind, id!),
        );
        throw error;
      }
      expect(downloads).toBe(1);
      expect(admissions).toBe(1);
      expect(readFileSync(join(data, "tile-fonts/Test Font/0-255.pbf"), "utf8")).toBe(
        "synthetic-public-glyph",
      );
      const rows = (await store.listUnsettled()).filter((row) =>
        existsSync(
          join(infra, "control-private/data-manager/executions", `${row.status.operationKey}.json`),
        ),
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.status.status).toBe("ok");
      expect(rows[0]?.parent?.issuer).toBe("host-cli");
      expect(rows[0]?.execution.principal).toBe("host-cli");
      control.verifyDataControlTerminalWitness(
        agentInstallation,
        rows[0]!.execution,
        rows[0]!.status,
      );
      expect(existsSync(join(data, ".admin-target-control/locks/data-manager"))).toBe(false);
    } finally {
      await runtime.close();
      agent.server.closeAllConnections();
      await agent.close();
      app.server.closeAllConnections();
      await app.close();
      fontServer.closeAllConnections();
      await new Promise<void>((resolve) => fontServer.close(() => resolve()));
      for (const row of await store.listUnsettled())
        if (
          existsSync(
            join(
              infra,
              "control-private/data-manager/executions",
              `${row.status.operationKey}.json`,
            ),
          )
        )
          await sql`DELETE FROM data_manager.jobs WHERE id=${row.status.id}`;
      journal.close();
      control.closeControlInstallation(dm);
      control.closeControlInstallation(agentInstallation);
      await sql.end();
      for (const key of envKeys) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
      rmSync(root, { recursive: true, force: true });
    }
  },
  60000,
);
