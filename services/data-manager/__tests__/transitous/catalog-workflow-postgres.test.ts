/** Actual durable workers + PostgreSQL + a separate production agent. Only
 * external Docker/MOTIS IO and pinned upstream CSV bytes are synthetic here. */
import { execFile as execFileCallback, execFileSync, spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import * as control from "@openmapx/core/build-artifacts";
import {
  createCatalogPinSet,
  initializeManagedCatalogPins,
  readCatalogPinSet,
  readCatalogValidation,
} from "@openmapx/core/catalog-pins";
import * as sdk from "@openmapx/core/data-manager-sdk";
import { createControlRootOperationKey, OpsClient } from "@openmapx/core/ops";
import {
  feedState,
  jobStages,
  jobs,
  offlinePackageArtifactReferences,
  offlinePackageJobOwners,
  offlinePackageJobs,
} from "@openmapx/db-schema";
import { applyHardlinkPlan } from "@openmapx/hardlinks";
import { renderFeedProxyNginxConfig } from "@openmapx/motis-feed-proxy-config";
import {
  catalogCompilerSettings,
  catalogReviewInputDigests,
  resolveOperationsProfileFromEnv,
} from "@openmapx/transitous-core";
import { drizzle } from "drizzle-orm/postgres-js";
import Fastify from "fastify";
import { expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../../../../apps/api/src/test/postgres-fixture";
import { ownedServiceHost } from "../../../../apps/ops-agent/src/__fixtures__/owned-service-host";
import { runContainedProcess } from "../../../../apps/ops-agent/src/docker-runtime";
import { buildTransitousRunnerServer } from "../../../../apps/transitous-runner/src/server";
import { ensureMotisSlotLayout } from "../../src/jobs/transitous/slot-state";
import { buildTinyGtfsFeeds } from "./fixtures/build-tiny-gtfs";
import { BERLIN_TINY_OSM_PBF_BASE64 } from "./fixtures/tiny-osm";

const state = vi.hoisted(() => ({
  db: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
}));
vi.mock("../../src/db/index", () => ({
  get db() {
    return state.db.db;
  },
  get sql() {
    return state.db.sql;
  },
  get rawSql() {
    return state.db.sql;
  },
}));
const csv =
  "Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL\n";
vi.mock("@openmapx/core/utils/safe-download", async (original) => ({
  ...(await original<typeof import("@openmapx/core/utils/safe-download")>()),
  safeFetchTextResponse: async (url: string) => ({
    text: csv,
    status: 200,
    headers: new Headers(),
    finalUrl: url,
  }),
}));
const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
const execFile = promisify(execFileCallback);
const MOTIS_IMAGE =
  "ghcr.io/motis-project/motis:2.11.3@sha256:7126a80f8d1537426655a14a121e395e9d56451c36144f3a1ce5c3e4deb38f64";
let motisPort = 0;

it
  .skipIf(!enabled)
  .each([
    "none",
    "pointer",
    "before-pointer",
    "dm-pointer",
    "cancel-pointer",
    "runner-refusal",
    ...(process.env.OPENMAPX_CATALOG_LIVE_MOTIS === "1" ? (["live"] as const) : []),
  ] as const)(
  "validates then activates one exact pair through actual workers / separate production agent (%s)",
  async (fault) => {
    state.db = await createMigratedPostgresFixture();
    const motis = Fastify(),
      bridge = Fastify();
    let agent: ReturnType<typeof spawn> | undefined,
      host: Awaited<ReturnType<typeof ownedServiceHost>> | undefined,
      dm: ReturnType<typeof Fastify> | undefined,
      runner: ReturnType<typeof buildTransitousRunnerServer> | undefined,
      installation: control.ControlInstallation | undefined,
      agentInstallation: control.ControlInstallation | undefined,
      journal: ReturnType<typeof control.createDataExecutionControlJournal> | undefined,
      runtime:
        | Awaited<
            ReturnType<
              typeof import("../../src/jobs/execution/runtime")["createDataExecutionRuntime"]
            >
          >
        | undefined;
    const children: ReturnType<typeof spawn>[] = [];
    const liveNames = new Set<string>(),
      livePorts = new Map<string, string>();
    const containerPrefix = `openmapx-catalog-${randomUUID()}`;
    async function removeLive(id: string) {
      const name = `${containerPrefix}-${id}`;
      if (liveNames.has(name)) {
        await execFile("docker", ["rm", "-f", name]);
        liveNames.delete(name);
      }
      livePorts.delete(id);
    }
    try {
      motis.all("/*", async (request, reply) => {
        if (fault === "live") {
          const [id, ...path] = request.url.slice(1).split("/"),
            port = livePorts.get(id!);
          if (!port) return reply.code(503).send({ error: "Owned MOTIS is stopped" });
          try {
            const response = await fetch(`http://127.0.0.1:${port}/${path.join("/")}`, {
              signal: AbortSignal.timeout(5000),
            });
            return reply
              .code(response.status)
              .type(response.headers.get("content-type") ?? "application/json")
              .send(await response.text());
          } catch {
            return reply.code(503).send({ error: "Owned MOTIS is importing" });
          }
        }
        return request.url.includes("/health")
          ? { rt: true, gbfs: true }
          : request.url.includes("/map/initial")
            ? { lat: 52.525, lon: 13.369, zoom: 10, serverConfig: {} }
            : request.url.includes("/map/stops")
              ? []
              : { itineraries: [{}], direct: [], requestParameters: {}, debugOutput: {} };
      });
      const fetchOriginal = globalThis.fetch;
      let lostCancellationResponse = false;
      vi.stubGlobal(
        "fetch",
        async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const url = String(input);
          if (
            /^https:\/\/raw\.githubusercontent\.com\/MobilityData\/gbfs\/[bc]{40}\/systems\.csv$/.test(
              url,
            )
          )
            return new Response(csv, { headers: { "content-type": "text/csv" } });
          const response = await fetchOriginal(input, init);
          if (
            fault === "cancel-pointer" &&
            init?.method === "POST" &&
            /\/executions\/[^/]+\/cancel$/.test(url) &&
            !lostCancellationResponse
          ) {
            lostCancellationResponse = true;
            throw new TypeError("Fixture dropped the actual cancellation response");
          }
          return response;
        },
      );
      const motisUrl = await motis.listen({ host: "127.0.0.1", port: motisPort });
      motisPort = Number(new URL(motisUrl).port);
      const environment = {
        MOTIS_TWO_SLOT: "true",
        MOTIS_GBFS_CATALOG_ENABLED: "true",
        MOTIS_OPERATIONS_PROFILE: "regional-assisted",
        TRANSITOUS_COUNTRIES: "de",
        TRANSIT_SOURCE: "build",
      };
      for (const [key, value] of Object.entries({
        ...environment,
        MOTIS_URL: `${motisUrl}/primary`,
        MOTIS_STAGING_URL: `${motisUrl}/staging`,
        MOTIS_HEALTH_PLAN_TO_LAT: "52.521",
        MOTIS_HEALTH_PLAN_TO_LNG: "13.413",
        MOTIS_IMPORT_TIMEOUT_MS: "60000",
        GIT_ALLOW_PROTOCOL: "file",
      }))
        vi.stubEnv(key, value);
      host = await ownedServiceHost({
        withCoordinator: true,
        extraServiceIds: ["motis-staging", "motis-feed-proxy"],
        environment: { "data-manager": environment },
        actualComposeConfig: true,
      });
      const f = host,
        data = join(f.infraDir, "data"),
        catalog = join(data, ".transitous-catalog"),
        atlas = join(catalog, "transitland-atlas");
      const feeds = await buildTinyGtfsFeeds(join(f.root, "tiny-feeds"));
      mkdirSync(join(catalog, "feeds"), { recursive: true });
      mkdirSync(join(atlas, "feeds"), { recursive: true });
      mkdirSync(join(f.root, "services/motis/tools/transitous"), { recursive: true });
      cpSync(
        resolve("services/data-manager/__tests__/transitous/fixtures/stub-catalog-scripts"),
        join(catalog, "src"),
        { recursive: true },
      );
      const git = (cwd: string, args: string[]) =>
        execFileSync("git", args, {
          cwd,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.test",
            GIT_COMMITTER_NAME: "fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.test",
          },
        }).trim();
      git(atlas, ["init", "--initial-branch=main"]);
      writeFileSync(
        join(atlas, "feeds/feed.dmfr.json"),
        '{"feeds":[{"id":"f-outside","authorization":{"type":"query_param","param_name":"key"}}]}',
      );
      git(atlas, ["add", "."]);
      git(atlas, ["commit", "-m", "Atlas"]);
      if (fault === "live")
        writeFileSync(
          join(catalog, "berlin-tiny.osm.pbf"),
          Buffer.from(BERLIN_TINY_OSM_PBF_BASE64, "base64"),
        );
      const atlasSha = git(atlas, ["rev-parse", "HEAD"]),
        feed = feeds.entries.find((entry) => entry.region === "de")!;
      git(catalog, ["init", "--initial-branch=main"]);
      writeFileSync(
        join(catalog, "feeds/de.json"),
        JSON.stringify({
          sources: [
            {
              name: "demo",
              type: "url",
              url: `file://${feed.zipPath}`,
              license: { name: "Synthetic test terms" },
            },
          ],
        }),
      );
      writeFileSync(
        join(catalog, "feeds/ca.json"),
        JSON.stringify({ sources: [{ name: "outside", "transitland-atlas-id": "f-outside" }] }),
      );
      writeFileSync(
        join(catalog, ".gitmodules"),
        `[submodule "transitland-atlas"]\npath = transitland-atlas\nurl = ${atlas}\n`,
      );
      git(catalog, [
        "add",
        "feeds",
        "src",
        ".gitmodules",
        ...(fault === "live" ? ["berlin-tiny.osm.pbf"] : []),
      ]);
      git(catalog, [
        "update-index",
        "--add",
        "--cacheinfo",
        `160000,${atlasSha},transitland-atlas`,
      ]);
      git(catalog, ["commit", "-m", "Catalog"]);
      const sha = git(catalog, ["rev-parse", "HEAD"]),
        remote = join(f.root, "upstream.git");
      git(f.root, ["clone", "--bare", catalog, remote]);
      git(catalog, ["remote", "add", "origin", remote]);
      git(catalog, ["fetch", "origin"]);
      git(catalog, ["branch", "--set-upstream-to=origin/main", "main"]);
      vi.stubEnv("TRANSITOUS_REPO_URL", remote);
      const lockedAt = new Date().toISOString(),
        oldGbfs = "b".repeat(40),
        nextGbfs = "c".repeat(40);
      writeFileSync(
        join(f.infraDir, "transitous.lock.json"),
        JSON.stringify({
          ref: `main@${sha}`,
          submodules: { "transitland-atlas": atlasSha },
          lockedAt,
          lockedBy: "fixture",
        }),
      );
      const gbfs = {
        schemaVersion: 1 as const,
        source: "mobilitydata-gbfs" as const,
        commit: oldGbfs,
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${oldGbfs}/systems.csv`,
        sha256: createHash("sha256").update(csv).digest("hex"),
        lockedAt,
        lockedBy: "fixture",
      };
      writeFileSync(join(f.infraDir, "gbfs-catalog.lock.json"), JSON.stringify(gbfs));
      const serviceIds = f.loaded.map((service) => service.manifest.id);
      installation = control.openControlInstallation({
        infraDir: f.infraDir,
        role: "data-manager",
        serviceIds,
      });
      agentInstallation = control.openControlInstallation({
        infraDir: f.infraDir,
        role: "ops-agent",
        serviceIds,
      });
      await initializeManagedCatalogPins({ rootDir: f.root, installation: agentInstallation });
      const active = readCatalogPinSet(f.root)!;
      mkdirSync(join(data, "motis-feed-proxy/conf"), { recursive: true });
      writeFileSync(
        join(data, "motis-feed-proxy/conf/default.conf"),
        renderFeedProxyNginxConfig({}),
      );
      writeFileSync(join(data, "motis-feed-proxy/feed-proxy-vars.json"), "{}\n");
      applyHardlinkPlan(
        [
          {
            source: "motis-feed-proxy/conf",
            target: "motis-feed-proxy/motis-feed-proxy-config",
            consumerService: "motis-feed-proxy",
            dataType: "motis-feed-proxy-config",
          },
        ],
        { rootDir: data },
      );
      const rows = ["motis", "data-manager", "motis-staging", "motis-feed-proxy"].map(
        (id, index) => ({
          ...structuredClone(f.row),
          Id: String(index + 1).repeat(64),
          ConfigImage: `example/${id}:1`,
          Labels: { ...f.row.Labels, "com.docker.compose.service": id },
        }),
      );
      f.setRows(rows);
      f.setRuntimeInspections(
        Object.fromEntries(
          rows.map((row) => [
            row.Id,
            {
              Config: {
                Env:
                  row.Labels["com.docker.compose.service"] === "data-manager"
                    ? Object.entries(environment).map(([key, value]) => `${key}=${value}`)
                    : [],
              },
              Mounts:
                row.Labels["com.docker.compose.service"] === "data-manager"
                  ? [
                      {
                        Source: join(f.root, "services/motis/tools/transitous"),
                        Destination: "/config/transitous",
                        RW: false,
                      },
                    ]
                  : [],
            },
          ]),
        ),
      );
      const calls: string[][] = [];
      bridge.post("/docker", async (request) => {
        const { args } = request.body as { args: string[] };
        calls.push(args);
        const filter = args.find((value) => value.startsWith("name=^/"));
        if (args[0] === "container" && args[1] === "ls" && filter) {
          const id = filter.slice(7, -1);
          const row = rows.find((row) => row.Labels["com.docker.compose.service"] === id);
          return { stdout: row ? `${id}\t${row.State}\n` : "", stderr: "" };
        }
        if (args[0] === "stop") {
          if (fault === "live") await removeLive(args[1] === "motis" ? "primary" : "staging");
          const row = rows.find((row) => row.Labels["com.docker.compose.service"] === args[1]);
          if (row) row.State = "exited";
          return { stdout: "", stderr: "" };
        }
        if (args[0] === "compose" && args.includes("up")) {
          if (fault === "live") {
            const id = args.at(-1) === "motis" ? "primary" : "staging",
              name = `${containerPrefix}-${id}`;
            await removeLive(id);
            const mount = realpathSync(
              join(data, id === "primary" ? "motis/live" : "motis/staging"),
            );
            liveNames.add(name);
            await execFile(
              "docker",
              [
                "run",
                "-d",
                "--name",
                name,
                "--memory=1g",
                "--cpus=2",
                "--user",
                `${process.getuid!()}:${process.getgid!()}`,
                "-p",
                "127.0.0.1::8080",
                "--mount",
                `type=bind,src=${mount},dst=/motis-data`,
                "--workdir",
                "/motis-data",
                "--entrypoint",
                "/bin/sh",
                MOTIS_IMAGE,
                "-c",
                "/motis import && exec /motis server",
              ],
              { timeout: 30000 },
            );
            const { stdout } = await execFile("docker", ["port", name, "8080/tcp"]);
            livePorts.set(id, stdout.trim().split(":").at(-1)!);
          }
          const row = rows.find((row) => row.Labels["com.docker.compose.service"] === args.at(-1));
          if (row) row.State = "running";
        }
        if (args[0] === "exec") {
          // Execute the real fixed validation shell/nonce protocol, substituting
          // only the nginx binary normally provided by Docker.
          const bin = join(f.root, "fixture-bin");
          mkdirSync(bin, { recursive: true });
          writeFileSync(join(bin, "nginx"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
          return runContainedProcess(
            "/bin/sh",
            [
              "-c",
              'PATH="$1:$PATH"; export PATH; shift; exec "$@"',
              "docker-io",
              bin,
              ...args.slice(2),
            ],
            { signal: AbortSignal.timeout(30000), timeout: 30000, maxBuffer: 65536 },
          );
        }
        return f.execFile("docker", args, {
          signal: AbortSignal.timeout(30000),
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
      });
      const dockerBridge = (await bridge.listen({ host: "127.0.0.1", port: 0 })) + "/docker";
      const require = createRequire(import.meta.url),
        loader = require.resolve("tsx/esm");
      async function startAgent(catalogFault: string, listenPort = 0) {
        const child = spawn(
          process.execPath,
          [
            "--import",
            loader,
            resolve("apps/ops-agent/src/test-fixtures/staged-coordinator-request-process.mjs"),
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        let stderr = "";
        child.stderr!.on("data", (chunk) => {
          stderr += String(chunk);
        });
        const lines = createInterface({ input: child.stdout! }),
          iterator = lines[Symbol.asyncIterator]();
        child.stdin!.end(
          JSON.stringify({
            root: f.root,
            infraDir: f.infraDir,
            queue: f.queue,
            stack: f.stack,
            serviceIds,
            token: f.token,
            dockerBridge,
            catalogFault: catalogFault === "dm-pointer" ? "pointer" : catalogFault,
            listenPort,
            operationTimeoutMs: 3600000,
          }),
        );
        const events: Record<string, unknown>[] = [];
        let readyResolve!: (value: string) => void,
          readyReject!: (reason: unknown) => void,
          stoppedResolve!: () => void;
        const ready = {
            promise: new Promise<string>((resolve, reject) => {
              readyResolve = resolve;
              readyReject = reject;
            }),
            resolve: (value: string) => readyResolve(value),
            reject: (reason: unknown) => readyReject(reason),
          },
          stopped = {
            promise: new Promise<void>((resolve) => {
              stoppedResolve = resolve;
            }),
            resolve: () => stoppedResolve(),
          };
        void (async () => {
          for await (const line of { [Symbol.asyncIterator]: () => iterator }) {
            const event = JSON.parse(line);
            events.push(event);
            if (event.event === "ready") ready.resolve(event.url);
            if (
              ["catalog-pointer-committed", "catalog-pointer-before-commit"].includes(
                String(event.event),
              )
            )
              stopped.resolve();
          }
        })().catch(ready.reject);
        child.once("exit", (code) => {
          ready.reject(Error(`Native agent exited ${code}: ${stderr}`));
        });
        const url = await Promise.race([
          ready.promise,
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(Error(`Native agent startup timeout: ${stderr}`)),
              30000,
            ).unref(),
          ),
        ]);
        return {
          child,
          url,
          stopped: stopped.promise,
          events,
          get stderr() {
            return stderr;
          },
        };
      }
      let processAgent = await startAgent(fault);
      agent = processAgent.child;
      const { resetOpsClient } = await import("../../src/ops-client");
      const tokenFile = join(f.root, "dm-token"),
        token = Buffer.alloc(32, 23).toString("base64url");
      writeFileSync(tokenFile, token, { mode: 0o600 });
      resetOpsClient(new OpsClient({ baseUrl: processAgent.url, tokenFile }));
      const ops = new OpsClient({ baseUrl: processAgent.url, tokenFile });
      const pins = createCatalogPinSet(active.transitous, {
        ...gbfs,
        commit: nextGbfs,
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${nextGbfs}/systems.csv`,
      });
      const proposalId = randomUUID(),
        policy = resolveOperationsProfileFromEnv(environment),
        source = catalogReviewInputDigests(policy, null, catalogCompilerSettings(environment));
      const proposalDeadline = Date.now() + 60000;
      await ops.execute(
        {
          kind: "transitousLock.propose",
          proposalId,
          baseGenerationId: active.generationId,
          pins,
          diffDigest: "d".repeat(64),
          sourcePolicyRevision: source.sourcePolicyRevision,
        },
        {
          operationKey: createControlRootOperationKey({
            notAfter: proposalDeadline,
            nonce: randomBytes(16),
          }),
          execution: { requestedDeadlineAt: proposalDeadline },
        },
      );
      mkdirSync(join(data, "motis/proposals", proposalId), { recursive: true, mode: 0o700 });
      const keyText = randomBytes(32).toString("hex"),
        capabilityKey = Buffer.from(keyText),
        keyFile = join(f.root, "runner-key");
      writeFileSync(keyFile, keyText, { mode: 0o600 });
      let runnerRefused = false;
      runner = buildTransitousRunnerServer({
        catalogDir: catalog,
        stagingDir: join(data, "gtfs"),
        capabilityKey: fault === "runner-refusal" ? randomBytes(64) : capabilityKey,
      });
      runner.addHook("onSend", async (_request, reply, payload) => {
        if (reply.statusCode === 401) runnerRefused = true;
        return payload;
      });
      vi.stubEnv("TRANSITOUS_RUNNER_URL", await runner.listen({ host: "127.0.0.1", port: 0 }));
      vi.stubEnv("TRANSITOUS_RUNNER_CAPABILITY_KEY_FILE", keyFile);
      const { createDataConfigurationMaintenance } = await import(
          "../../src/jobs/execution/configuration-maintenance"
        ),
        { createPostgresDataExecutionStore } = await import("../../src/jobs/execution/store"),
        { createDataExecutionRuntime } = await import("../../src/jobs/execution/runtime"),
        { createDataExecutionReceiver } = await import("../../src/jobs/execution/receiver"),
        { createDataExecutionDispatcher } = await import("../../src/jobs/execution/dispatch"),
        { createSingleFlightController } = await import("../../src/jobs/transitous/single-flight"),
        { StateStore } = await import("../../src/state"),
        { registerAuth } = await import("../../src/auth"),
        { registerApi } = await import("../../src/api");
      journal = control.createDataExecutionControlJournal(installation, state.db.sql);
      const fence = createDataConfigurationMaintenance(state.db.sql, installation);
      await fence.startup();
      const store = createPostgresDataExecutionStore(state.db.sql, {
          controlJournal: journal,
          configurationFence: fence,
        }),
        singleFlight = createSingleFlightController({
          db: drizzle(state.db.sql, {
            schema: {
              jobs,
              jobStages,
              feedState,
              offlinePackageJobs,
              offlinePackageJobOwners,
              offlinePackageArtifactReferences,
            },
          }),
        }),
        dispatcher = createDataExecutionDispatcher({
          dataDir: data,
          state: new StateStore(data),
          sql: state.db.sql,
          singleFlight,
          operationsPolicy: policy,
          runHardlinks: async () => {
            throw Error("No generation operation in catalog workflow");
          },
        });
      runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch });
      const receiver = createDataExecutionReceiver({
        runtime,
        installation,
        configurationFence: fence,
        dispatcher,
        operationsPolicy: policy,
      });
      dm = Fastify();
      registerAuth(dm, token, { executionReceiver: () => receiver });
      registerApi(dm, {
        dataDir: data,
        singleFlight,
        operationsPolicy: policy,
        executionReceiver: receiver,
      });
      let dmUrl = await dm.listen({ host: "127.0.0.1", port: 0 }),
        transport = sdk.createDataManagerTransport({ baseUrl: dmUrl, authToken: token });
      async function startNativeDm(listenPort = 0) {
        const child = spawn(
          process.execPath,
          [
            "--import",
            loader,
            resolve("services/data-manager/__tests__/fixtures/catalog-data-manager-process.mjs"),
          ],
          { stdio: ["pipe", "pipe", "pipe"] },
        );
        children.push(child);
        let stderr = "";
        child.stderr!.on("data", (value) => {
          stderr += String(value);
        });
        child.stdin!.end(
          JSON.stringify({
            databaseUrl: state.db.connectionUri,
            agentUrl: processAgent.url,
            tokenFile,
            infraDir: f.infraDir,
            dataDir: data,
            serviceIds,
            token,
            csv,
            listenPort,
            environment: Object.fromEntries(
              Object.entries(process.env).filter(([key]) =>
                /^(MOTIS|TRANSITOUS|TRANSIT_SOURCE|GIT_ALLOW_PROTOCOL)/.test(key),
              ),
            ),
          }) + "\n",
        );
        const lines = createInterface({ input: child.stdout! });
        const ready = new Promise<string>((resolve, reject) => {
          child.once("exit", (code) => reject(Error(`Native DM exited ${code}: ${stderr}`)));
          void (async () => {
            for await (const line of lines) {
              const event = JSON.parse(line);
              if (event.event === "ready") resolve(event.url);
              else stderr += line + "\n";
            }
          })().catch(reject);
        });
        const url = await Promise.race([
          ready,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Error(`Native DM startup timeout: ${stderr}`)), 60000).unref(),
          ),
        ]);
        return {
          child,
          url,
          get stderr() {
            return stderr;
          },
        };
      }
      let nativeDm: Awaited<ReturnType<typeof startNativeDm>> | undefined;
      if (fault === "dm-pointer" || fault === "runner-refusal" || fault === "before-pointer") {
        await runtime.close();
        nativeDm = await startNativeDm();
        transport = sdk.createDataManagerTransport({ baseUrl: nativeDm.url, authToken: token });
      }
      async function terminal(id: string) {
        let status = sdk.unwrapDataManagerResponse(await sdk.getDataExecution(id, { transport }));
        const until = Date.now() + 90000;
        while (
          ["queued", "running", "cancel_pending"].includes(status.status) &&
          Date.now() < until &&
          !(
            status.publication === "unknown" &&
            (fault === "runner-refusal" ||
              status.diagnostics.tail.some((line) => line.stream === "stderr"))
          )
        ) {
          await new Promise((resolve) => setTimeout(resolve, 100));
          status = sdk.unwrapDataManagerResponse(await sdk.getDataExecution(id, { transport }));
          if (
            processAgent.events.some(
              (event) => event.event === "operation" && Number(event.status) >= 400,
            )
          )
            return status;
        }
        return status;
      }
      ensureMotisSlotLayout(data);
      const deadline = Date.now() + 3600000;
      const validation = sdk.unwrapDataManagerResponse(
        await sdk.startDataExecution(
          {
            input: { kind: "catalog.validate", proposalId, countries: ["de"] },
            operationKey: createControlRootOperationKey({
              notAfter: deadline,
              nonce: randomBytes(16),
            }),
            requestedDeadlineAt: deadline,
          },
          { transport },
        ),
      );
      const validated = await terminal(validation.id);
      if (fault === "runner-refusal") {
        await vi.waitFor(() => expect(runnerRefused).toBe(true), { timeout: 30000 });
        expect(validated.publication).toBe("unknown");
        expect(["running", "interrupted", "cancel_pending"]).toContain(validated.status);
        const [row] = await state.db
          .sql`SELECT finished_at FROM data_manager.jobs WHERE id=${validation.id}`;
        expect(row!.finished_at).toBeNull();
        expect(existsSync(join(data, ".admin-target-control/locks/motis"))).toBe(true);
        return;
      }
      expect(
        validated,
        JSON.stringify({
          status: validated,
          agent: processAgent.events,
          stages: await state.db
            .sql`SELECT stage,status,message,artifacts FROM data_manager.job_stages WHERE job_id=${validation.id}`,
        }),
      ).toMatchObject({ status: "ok", result: { kind: "catalog.validate", status: "passed" } });
      const proof = readCatalogValidation(installation, proposalId, validation.id);
      expect(proof.validation.status).toBe("passed");
      expect(readCatalogPinSet(f.root)).toEqual(active);
      // Like the review eligibility reader, require the real immutable contained
      // completion, not merely the earlier visible SQL terminal projection.
      await vi.waitFor(
        () =>
          expect(() =>
            control.verifyDataControlTerminalWitness(installation!, proof.sourceExecution),
          ).not.toThrow(),
        { timeout: 10000, interval: 100 },
      );
      const completedValidation = await store.inspect(validation.id);
      const child = completedValidation!.children.find((child) => child.state === "terminal");
      if (!child || child.state !== "terminal")
        throw Error("Expected actual settled validation child");
      const originalOwner = control.restoreAdmittedControlExecution(
        installation,
        proof.sourceExecution,
      );
      expect(
        control.inspectRetainedOwnedArtifactTargetChildSettlement(originalOwner, child.execution)
          ?.outcome,
      ).toBe("committed");
      expect(() =>
        control.inspectRetainedOwnedArtifactTargetChildSettlement(originalOwner, {
          ...child.execution,
          executionId: randomUUID(),
        }),
      ).toThrow(/original child/);
      expect(existsSync(join(data, ".admin-target-control/locks/motis"))).toBe(false);
      const validationBytes = readFileSync(
        join(data, "motis/proposals", proposalId, `validation-${validation.id}.json`),
      );
      const originalPointer = readFileSync(join(f.infraDir, "catalog-pins/current.json"));
      const activation = sdk.unwrapDataManagerResponse(
        await sdk.startDataExecution(
          {
            input: {
              kind: "catalog.activate",
              proposalId,
              validationId: validation.id,
              expectedGenerationId: active.generationId,
              diffDigest: "d".repeat(64),
              acknowledgeLicenseChanges: true,
            },
            operationKey: createControlRootOperationKey({
              notAfter: deadline,
              nonce: randomBytes(16),
            }),
            requestedDeadlineAt: deadline,
          },
          { transport },
        ),
      );
      if (
        fault === "pointer" ||
        fault === "dm-pointer" ||
        fault === "cancel-pointer" ||
        fault === "before-pointer"
      ) {
        await Promise.race([
          processAgent.stopped,
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(Error("Pin pointer fault not reached")), 90000).unref(),
          ),
        ]);
        expect(readCatalogPinSet(f.root)?.generationId).toBe(
          fault === "before-pointer" ? active.generationId : pins.generationId,
        );
        if (fault === "cancel-pointer") {
          const cancelResponse = sdk
            .cancelDataExecution(
              activation.id,
              { operationKey: activation.operationKey, fingerprint: activation.fingerprint },
              { transport },
            )
            .then(
              () => false,
              () => true,
            );
          await vi.waitFor(
            async () =>
              expect(
                sdk.unwrapDataManagerResponse(
                  await sdk.getDataExecution(activation.id, { transport }),
                ).cancellationRequestedAt,
              ).not.toBeNull(),
            { timeout: 15000 },
          );
          expect(await cancelResponse).toBe(true);
          expect(lostCancellationResponse).toBe(true);
          expect(existsSync(join(data, ".admin-target-control/locks/motis"))).toBe(true);
        }
        if (nativeDm) {
          nativeDm.child.kill("SIGKILL");
          await new Promise((resolve) => nativeDm!.child.once("exit", resolve));
        }
        agent!.kill("SIGKILL");
        await new Promise((resolve) => agent!.once("exit", resolve));
        processAgent = await startAgent("none", Number(new URL(processAgent.url).port));
        agent = processAgent.child;
        resetOpsClient(new OpsClient({ baseUrl: processAgent.url, tokenFile }));
        if (nativeDm) {
          nativeDm = await startNativeDm(Number(new URL(nativeDm.url).port));
          transport = sdk.createDataManagerTransport({ baseUrl: nativeDm.url, authToken: token });
        }

        // Existing pending child addresses retain the original agent endpoint.
        // The same owned loopback port is restored below by the native fixture.
      }
      if (fault === "before-pointer") {
        const retained = await store.inspect(activation.id),
          approval = retained!.children.find((child) => child.phase === "paired-pin-commit");
        if (!approval || approval.state === "reserved" || approval.state === "bound")
          throw Error("Original attempted approval required");
        expect(await ops.status("transitousLock.approve", approval.proposedId)).toMatchObject({
          state: "failed",
          errorClass: "recovery_required",
        });
        expect(readFileSync(join(f.infraDir, "catalog-pins/current.json"))).toEqual(
          originalPointer,
        );
        expect(processAgent.events.some((event) => event.kind === "transitousLock.approve")).toBe(
          false,
        );
        const pending = sdk.unwrapDataManagerResponse(
          await sdk.getDataExecution(activation.id, { transport }),
        );
        expect(pending.publication).toBe("unknown");
        await sdk.cancelDataExecution(
          activation.id,
          { operationKey: activation.operationKey, fingerprint: activation.fingerprint },
          { transport },
        );
        const [row] = await state.db
          .sql`SELECT finished_at FROM data_manager.jobs WHERE id=${activation.id}`;
        expect(row!.finished_at).toBeNull();
        expect(existsSync(join(data, ".admin-target-control/locks/motis"))).toBe(true);
        const next = await sdk.startDataExecution(
          {
            input: { kind: "catalog.validate", proposalId, countries: ["de"] },
            operationKey: createControlRootOperationKey({
              notAfter: deadline,
              nonce: randomBytes(16),
            }),
            requestedDeadlineAt: deadline,
          },
          { transport },
        );
        expect(next.status).toBe(409);
        return;
      }
      const activated = await terminal(activation.id);
      expect(
        activated,
        JSON.stringify({
          status: activated,
          agent: processAgent.events,
          agentDiagnostics: processAgent.stderr,
          nativeDmDiagnostics: nativeDm?.stderr,
        }),
      ).toMatchObject({
        status: "ok",
        result: { outcome: "activated", generationId: pins.generationId },
      });
      expect(readCatalogPinSet(f.root)?.generationId).toBe(pins.generationId);
      expect(
        readFileSync(join(data, "motis/proposals", proposalId, `validation-${validation.id}.json`)),
      ).toEqual(validationBytes);
      expect(
        calls.filter(
          (args) => args[0] === "compose" && args.includes("up") && args.at(-1) === "motis",
        ),
      ).toHaveLength(1);
    } finally {
      await runtime?.close();
      for (const id of ["primary", "staging"]) await removeLive(id);
      for (const child of children) {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill("SIGKILL");
          await new Promise((resolve) => child.once("exit", resolve));
        }
      }
      if (dm) {
        dm.server.closeAllConnections();
        await dm.close();
      }
      await runner?.close();
      await bridge.close();
      await motis.close();
      journal?.close();
      if (installation) control.closeControlInstallation(installation);
      if (agentInstallation) control.closeControlInstallation(agentInstallation);
      if (host) rmSync(host.cleanupRoot, { recursive: true, force: true });
      await state.db.stop();
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  },
  240000,
);
