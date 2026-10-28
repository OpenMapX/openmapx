/** Wiring acceptance: real production agent/default registered CLI/HTTP/SQL and
 * signed containment. Synthetic download workers and native Docker I/O keep
 * this test independent of public downloads and graph-container images. */
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as control from "@openmapx/core/build-artifacts";
import { createControlRootOperationKey, OpsClient, type OpsOperation } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { build } from "esbuild";
import Fastify from "fastify";
import postgres from "postgres";
import { expect, it } from "vitest";
import { ownedServiceHost } from "../../../../../apps/ops-agent/src/__fixtures__/owned-service-host";
import { configurationPolicyRevision } from "../../../../../apps/ops-agent/src/configured-resource-authority";
import { openOpsJobJournal } from "../../../../../apps/ops-agent/src/journal";
import { createProductionRegistryResourceClaimer } from "../../../../../apps/ops-agent/src/policy";
import { dispatchOpsOperation } from "../../../../../apps/ops-agent/src/runtime";
import { buildOpsAgentServer } from "../../../../../apps/ops-agent/src/server";
import { createFileTrustedOpsDataSource } from "../../../../../apps/ops-agent/src/trusted-config-source";
import { registerApi } from "../../api";
import { registerAuth } from "../../auth";
import { StateStore } from "../../state";
import { resolveOperationsProfile } from "../transitous/operations-profile";
import { getSingleFlightController } from "../transitous/runtime";
import { createDataConfigurationMaintenance } from "./configuration-maintenance";
import { createDataExecutionDispatcher } from "./dispatch";
import { applyOwnedGenerationHardlinks } from "./hardlinks";
import { createDataExecutionReceiver } from "./receiver";
import { createDataExecutionRuntime } from "./runtime";
import { createPostgresDataExecutionStore } from "./store";
import { publishDataChange, retainDataPublication } from "./worker-scope";

it.skipIf(
  !process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL &&
    process.env.OPENMAPX_RUN_DATABASE_TESTS !== "1",
)(
  "awaits the original transit child before native graph commands and generation, after a lost admission response",
  async () => {
    const url = process.env.OPENMAPX_DATA_EXECUTION_TEST_DATABASE_URL;
    if (!url) throw Error("Owned PostgreSQL required");
    const bundle = mkdtempSync(join(tmpdir(), "omx-full-update-bundle-"));
    await build({
      entryPoints: [resolve("packages/cli/__tests__/fixtures/single-data-cli-process.ts")],
      outfile: join(bundle, "cli.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      tsconfig: resolve("packages/cli/tsconfig.json"),
      banner: {
        js: `import {createRequire} from 'node:module';const require=createRequire(${JSON.stringify(resolve("packages/cli/package.json"))});`,
      },
    });
    const host = await ownedServiceHost({
        withHardlinks: true,
        extraServiceIds: ["osrm", "motis-feed-proxy", "motis-staging"],
        defaultCliEntry: join(bundle, "agent.mjs"),
      }),
      data = join(host.infraDir, "data"),
      sql = postgres(url, { max: 4 });
    const keys = [
        "OPENMAPX_ROOT_DIR",
        "DATA_MANAGER_URL",
        "DATA_MANAGER_AUTH_TOKEN",
        "POSTGRES_PASSWORD",
        "BETTER_AUTH_SECRET",
        "DOMAIN",
        "PATH",
      ] as const,
      prior = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    process.env.DOMAIN = "example.test";
    process.env.OPENMAPX_ROOT_DIR = host.root;
    process.env.DATA_MANAGER_AUTH_TOKEN = "synthetic-full-update-token-" + "d".repeat(32);
    process.env.POSTGRES_PASSWORD = "synthetic-full-update-password-" + "p".repeat(32);
    process.env.BETTER_AUTH_SECRET = "synthetic-full-update-secret-" + "s".repeat(32);
    const service = host.loaded.find((s) => s.manifest.id === "osrm")!;
    service.manifest.buildCommand = "openmapx services build osrm";
    writeFileSync(join(service.directory, "service.json"), JSON.stringify(service.manifest));
    const docker = join(bundle, "docker"),
      commands = join(bundle, "docker-commands.jsonl");
    writeFileSync(
      docker,
      `#!${process.execPath}\nconst fs=require('node:fs'),path=require('node:path'),a=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(commands)},JSON.stringify(a)+'\\n');if(a[0]==='run'){const m=a[a.indexOf('-v')+1];if(m&&m.endsWith(':/data'))fs.writeFileSync(path.join(m.slice(0,-6),'region.osrm'),'synthetic-graph');}if(a.includes('ps'))process.stdout.write('');\n`,
      { mode: 0o700 },
    );
    chmodSync(docker, 0o700);
    process.env.PATH = `${bundle}:${process.env.PATH}`;
    const dm = control.openControlInstallation({
        infraDir: host.infraDir,
        role: "data-manager",
        serviceIds: host.loaded.map((s) => s.manifest.id).sort(),
      }),
      agentInstallation = control.openControlInstallation({
        infraDir: host.infraDir,
        role: "ops-agent",
        serviceIds: host.loaded.map((s) => s.manifest.id).sort(),
      }),
      journal = control.createDataExecutionControlJournal(dm, sql),
      fence = createDataConfigurationMaintenance(sql, dm);
    const publicationFailures: Record<string, string> = {};
    const publishContained = journal.publishContainedTerminal;
    journal.publishContainedTerminal = async (execution) => {
      try {
        return await publishContained(execution);
      } catch (error) {
        publicationFailures[execution.operationKey] =
          error instanceof Error ? (error.stack ?? error.message) : String(error);
        throw error;
      }
    };
    await fence.startup();
    const store = createPostgresDataExecutionStore(sql, {
        controlJournal: journal,
        configurationFence: fence,
      }),
      singleFlight = getSingleFlightController(),
      operationsPolicy = resolveOperationsProfile({ countries: ["de"] });
    let releaseTransit!: () => void, transitStarted!: () => void;
    const held = new Promise<void>((resolve) => {
        releaseTransit = resolve;
      }),
      started = new Promise<void>((resolve) => {
        transitStarted = resolve;
      });
    const effects: string[] = [];
    const dispatcher = createDataExecutionDispatcher({
      dataDir: data,
      state: new StateStore(data),
      sql,
      singleFlight,
      operationsPolicy,
      runHardlinks: async () => {
        throw Error("Actual generation receiver owns its hardlink worker");
      },
    });
    const runtime = createDataExecutionRuntime({
        store,
        dispatch: async (input, context) => {
          effects.push(input.kind);
          if (input.kind === "generation-hardlinks") return applyOwnedGenerationHardlinks(context);
          if (input.kind === "download-osm") {
            await publishDataChange(() => {
              mkdirSync(join(data, "osm"), { recursive: true });
              writeFileSync(join(data, "osm/europe-germany.osm.pbf"), "synthetic-public-osm");
              mkdirSync(join(data, "source-osm"), { recursive: true });
              writeFileSync(join(data, "source-osm/input.pbf"), "synthetic-public-osm");
            });
            return { kind: input.kind, region: input.region, sizeBytes: 20 };
          }
          if (input.kind === "transit-sync") {
            transitStarted();
            await held;
            context.assertForward();
            await retainDataPublication();
            return {
              kind: input.kind,
              countries: input.countries,
              sourceRevision: "synthetic-catalog",
              finalStatus: "ok",
            };
          }
          if (input.kind === "download-fonts") {
            await retainDataPublication();
            return { kind: input.kind, completed: true };
          }
          throw Error("Unexpected synthetic download worker");
        },
      }),
      receiver = createDataExecutionReceiver({
        runtime,
        installation: dm,
        configurationFence: fence,
        dispatcher,
        operationsPolicy,
      }),
      app = Fastify();
    const responses: { status: number; payload: string }[] = [];
    let admissions = 0;
    app.addHook("onSend", async (request, reply, payload) => {
      if (request.method === "POST" && request.url === "/executions") {
        responses.push({
          status: reply.statusCode,
          payload: typeof payload === "string" ? payload.slice(0, 1000) : "non-string",
        });
        admissions++;
        if (admissions === 2) reply.raw.destroy();
      }
      return payload;
    });
    registerAuth(app, process.env.DATA_MANAGER_AUTH_TOKEN, { executionReceiver: () => receiver });
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
    const agentJournal = await openOpsJobJournal(join(data, "ops-agent/jobs-v1.json")),
      token = "a".repeat(43),
      tokenFile = join(bundle, "token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    let actualFailure: unknown;
    const agent = buildOpsAgentServer({
      dispatch: async (op, runtime, context) => {
        try {
          return await dispatchOpsOperation(runtime, op, context);
        } catch (error) {
          actualFailure = error;
          throw error;
        }
      },
      runtime: host.runtime,
      journal: agentJournal,
      controlInstallation: agentInstallation,
      tokens: { api: token, "data-manager": "d".repeat(43) },
      resourceClaimer: createProductionRegistryResourceClaimer({
        services: host.loaded.map((s) => ({
          serviceId: s.manifest.id,
          enabled: s.enabled,
          isBuiltIn: s.isBuiltIn,
          selectionAuthority: s,
        })),
        integrationIds: [],
        loadAuthority: async () => {
          const a = await host.loadAuthority();
          return {
            revisionId: configurationPolicyRevision(a.revisionId),
            configurationAuthorityRevision: a.revisionId,
            services: a.services.map((s) => ({
              serviceId: s.manifest.id,
              enabled: s.enabled,
              isBuiltIn: s.isBuiltIn,
              selectionAuthority: s,
            })),
            integrationIds: [],
          };
        },
        enabledServiceIds: () => new Set(["data-manager", "motis", "osrm"]),
        trustedData: createFileTrustedOpsDataSource({
          directory: host.queue,
          token: host.token,
          allowedUids: [process.geteuid?.() ?? 0],
          expectedGid: process.getegid?.() ?? 0,
        }),
        ownedServices: host.owned,
        resourceAuthority: {
          allowRegion: (kind, id) => kind === "data.update" && id === "europe/germany",
          allowCountry: (kind, id) => kind === "data.update" && id === "DE",
        },
      }),
    });
    await agent.listen({ host: "127.0.0.1", port: 0 });
    const agentAddress = agent.server.address();
    if (!agentAddress || typeof agentAddress === "string") throw Error("Agent address missing");
    const client = new OpsClient({ baseUrl: `http://127.0.0.1:${agentAddress.port}`, tokenFile });
    let operationId: string | undefined, rootOperationKey: string | undefined;
    try {
      const operation: OpsOperation = {
          kind: "data.update",
          regionId: "europe/germany",
          countryCodes: ["DE"],
        },
        deadlineAt = Date.now() + 240000,
        key = createControlRootOperationKey({ notAfter: deadlineAt, nonce: randomBytes(16) }),
        admitted = await client.execute(operation, {
          operationKey: key,
          execution: { requestedDeadlineAt: deadlineAt },
        });
      if (admitted.execution !== "async") throw Error("Async Full Update required");
      operationId = admitted.operationId;
      rootOperationKey = key;
      await Promise.race([
        started,
        new Promise((_, reject) => setTimeout(() => reject(Error("Transit did not start")), 60000)),
      ]);
      expect(effects).toEqual(["download-osm", "transit-sync"]);
      expect(services.currentConfigurationGeneration(host.infraDir)).toBe(host.initial.revisionId);
      expect(existsSync(commands) ? readFileSync(commands, "utf8") : "").not.toContain(
        "osrm-extract",
      );
      expect(existsSync(join(data, ".admin-target-control/locks/osrm"))).toBe(false);
      releaseTransit();
      const until = Date.now() + 90000;
      let terminal = await client.status(operation.kind, operationId!);
      while (
        !["succeeded", "failed", "timed_out", "terminated"].includes(terminal.state) &&
        !actualFailure &&
        Date.now() < until
      ) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        terminal = await client.status(operation.kind, operationId!);
      }
      expect(terminal).toMatchObject({
        state: "succeeded",
        result: {
          completed: true,
          dataWorkflow: { phase: "complete", completedBuildIds: ["osrm"] },
        },
      });
      expect(admissions).toBe(3);
      expect(effects).toEqual([
        "download-osm",
        "transit-sync",
        "download-fonts",
        "generation-hardlinks",
      ]);
      expect(readFileSync(commands, "utf8")).toContain("osrm-extract");
      expect(existsSync(join(data, "osrm-graph/region.osrm"))).toBe(true);
      expect(services.currentConfigurationGeneration(host.infraDir)).not.toBe(
        host.initial.revisionId,
      );
      expect(existsSync(join(data, ".admin-target-control/locks/osrm"))).toBe(false);
    } catch (error) {
      const witnessProblems: Record<string, string> = {};
      for (const row of await store.listUnsettled()) {
        if (
          !existsSync(
            join(
              host.infraDir,
              "control-private/data-manager/executions",
              `${row.status.operationKey}.json`,
            ),
          )
        )
          continue;
        try {
          control.verifyDataControlTerminalWitness(agentInstallation, row.execution, row.status);
          witnessProblems[row.input.kind] = "verified";
        } catch (problem) {
          witnessProblems[row.input.kind] =
            problem instanceof Error ? (problem.stack ?? problem.message) : String(problem);
        }
      }
      if (operationId)
        console.info(
          "Full Update synthetic diagnostics",
          {
            effects,
            admissions,
            responses,
            witnessProblems,
            publicationFailures,
            actualFailure: actualFailure instanceof Error ? actualFailure.stack : actualFailure,
            rows: (await store.listUnsettled())
              .filter((row) =>
                existsSync(
                  join(
                    host.infraDir,
                    "control-private/data-manager/executions",
                    `${row.status.operationKey}.json`,
                  ),
                ),
              )
              .map((row) => ({
                kind: row.input.kind,
                status: row.status,
                finishedAt: row.finishedAt,
              })),
            commands: existsSync(commands) ? readFileSync(commands, "utf8") : "",
          },
          await client.status("data.update", operationId),
          await client.events(operationId),
        );
      throw error;
    } finally {
      releaseTransit();
      agent.server.closeAllConnections();
      await agent.close();
      app.server.closeAllConnections();
      await app.close();
      await runtime.close();
      for (const row of await store.listUnsettled())
        if (
          existsSync(
            join(
              host.infraDir,
              "control-private/data-manager/executions",
              `${row.status.operationKey}.json`,
            ),
          ) ||
          (rootOperationKey &&
            row.parent &&
            "execution" in row.parent &&
            [
              control.controlChildOperationKey(rootOperationKey, "data-workflow", 0),
              control.controlChildOperationKey(rootOperationKey, "data-finalization", 1),
            ].includes(row.parent.execution.operationKey))
        )
          await sql`DELETE FROM data_manager.jobs WHERE id=${row.status.id} AND operation_key=${row.status.operationKey}`;
      journal.close();
      control.closeControlInstallation(dm);
      control.closeControlInstallation(agentInstallation);
      await sql.end();
      for (const key of keys) {
        if (prior[key] === undefined) delete process.env[key];
        else process.env[key] = prior[key];
      }
      rmSync(host.cleanupRoot, { recursive: true, force: true });
      rmSync(bundle, { recursive: true, force: true });
    }
  },
  180000,
);
