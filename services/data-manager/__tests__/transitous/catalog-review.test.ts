import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  closeControlInstallation,
  createDataExecutionControlJournal,
  openControlInstallation,
  provisionControlInstallation,
} from "@openmapx/core/build-artifacts";
import { initializeManagedCatalogPins, readCatalogPinSet } from "@openmapx/core/catalog-pins";
import { createControlRootOperationKey, OpsClient } from "@openmapx/core/ops";
import {
  feedState,
  jobStages,
  jobs,
  offlinePackageArtifactReferences,
  offlinePackageJobOwners,
  offlinePackageJobs,
} from "@openmapx/db-schema";
import { inspectPinnedFeedCredentialKeys } from "@openmapx/transitous-core";
import { drizzle } from "drizzle-orm/postgres-js";
import Fastify from "fastify";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { createMigratedPostgresFixture } from "../../../../apps/api/src/test/postgres-fixture";
import {
  createRegistryResourcePolicy,
  denyAllTrustedOpsData,
} from "../../../../apps/ops-agent/src/policy";
import { createUnavailableRuntime } from "../../../../apps/ops-agent/src/runtime";
import { buildOpsAgentServer } from "../../../../apps/ops-agent/src/server";
import { createTransitousLockRuntime } from "../../../../apps/ops-agent/src/transitous-lock-runtime";
import { registerApi } from "../../src/api";
import { registerAuth } from "../../src/auth";
import { installDataMutationAdmission } from "../../src/jobs/execution/admission";
import { createDataConfigurationMaintenance } from "../../src/jobs/execution/configuration-maintenance";
import { createDataExecutionDispatcher } from "../../src/jobs/execution/dispatch";
import { createDataExecutionReceiver } from "../../src/jobs/execution/receiver";
import { createDataExecutionRuntime } from "../../src/jobs/execution/runtime";
import { createPostgresDataExecutionStore } from "../../src/jobs/execution/store";
import { createCatalogReviewService } from "../../src/jobs/transitous/catalog-review";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile";
import { createSingleFlightController } from "../../src/jobs/transitous/single-flight";
import { resetOpsClient } from "../../src/ops-client";
import { StateStore } from "../../src/state";

const state = vi.hoisted(() => ({
  fixture: null as unknown as Awaited<ReturnType<typeof createMigratedPostgresFixture>>,
  requests: [] as string[],
}));
vi.mock("../../src/db/index", () => ({
  get sql() {
    return state.fixture.sql;
  },
  get rawSql() {
    return state.fixture.sql;
  },
  get db() {
    return state.fixture.db;
  },
}));
const oldCsv =
  "Country Code,Name,Location,System ID,URL,Auto-Discovery URL,Supported Versions,Authentication Info URL\nDE,Bike,Berlin,bike,https://operator.test,https://old.test/gbfs.json,2.3,\n";
const newCsv = oldCsv.replace("https://old.test/gbfs.json", "https://new.test/gbfs.json");
vi.mock("@openmapx/core/utils/safe-download", async (original) => ({
  ...(await original<typeof import("@openmapx/core/utils/safe-download")>()),
  safeFetchTextResponse: async (url: string) => {
    state.requests.push(url);
    const text = url.includes("api.github.com")
      ? JSON.stringify({ sha: "c".repeat(40) })
      : url.includes("b".repeat(40))
        ? oldCsv
        : newCsv;
    return { text, status: 200, headers: new Headers(), finalUrl: url };
  },
}));
const enabled = process.env.OPENMAPX_RUN_DATABASE_TESTS === "1";
let root = "",
  agent: ReturnType<typeof buildOpsAgentServer>,
  agentInstallation: ReturnType<typeof openControlInstallation>,
  dmInstallation: ReturnType<typeof openControlInstallation>;
beforeAll(async () => {
  if (enabled) state.fixture = await createMigratedPostgresFixture();
}, 90000);
afterAll(async () => {
  resetOpsClient();
  await agent?.close();
  if (dmInstallation) closeControlInstallation(dmInstallation);
  if (agentInstallation) closeControlInstallation(agentInstallation);
  if (root) rmSync(root, { recursive: true, force: true });
  if (state.fixture) await state.fixture.stop();
});
it.skipIf(!enabled)(
  "resolves a real-Git GBFS-only proposal through actual agent HTTP and retains exact replay",
  async () => {
    root = mkdtempSync(join(tmpdir(), "omx-catalog-review-"));
    const infra = join(root, "infra/docker"),
      dataDir = join(infra, "data"),
      catalog = join(dataDir, ".transitous-catalog");
    mkdirSync(join(catalog, "feeds"), { recursive: true });
    mkdirSync(join(catalog, "transitland-atlas"), { recursive: true });
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
    const atlas = join(catalog, "transitland-atlas");
    git(atlas, ["init", "--initial-branch=main"]);
    mkdirSync(join(atlas, "feeds"));
    writeFileSync(
      join(atlas, "feeds/bus.dmfr.json"),
      JSON.stringify({ feeds: [{ id: "auth", license: { spdx_identifier: "CC0-1.0" } }] }),
    );
    writeFileSync(join(atlas, "README"), "Atlas fixture");
    git(atlas, ["add", "."]);
    git(atlas, ["commit", "-m", "Atlas"]);
    const atlasSha = git(atlas, ["rev-parse", "HEAD"]);
    git(catalog, ["init", "--initial-branch=main"]);
    writeFileSync(
      join(catalog, "feeds/de.json"),
      JSON.stringify({
        sources: [
          {
            name: "bus",
            spec: "gtfs",
            url: "https://bus.test",
            license: { name: "Test terms" },
            "transitland-atlas-id": "auth",
          },
        ],
      }),
    );
    git(catalog, ["add", "feeds"]);
    git(catalog, ["update-index", "--add", "--cacheinfo", `160000,${atlasSha},transitland-atlas`]);
    git(catalog, ["commit", "-m", "Catalog"]);
    const sha = git(catalog, ["rev-parse", "HEAD"]);
    const remote = join(root, "upstream.git");
    git(root, ["clone", "--bare", catalog, remote]);
    git(catalog, ["remote", "add", "origin", remote]);
    await provisionControlInstallation(infra);
    agentInstallation = openControlInstallation({
      infraDir: infra,
      role: "ops-agent",
      serviceIds: ["data-manager", "motis", "motis-staging", "motis-feed-proxy"],
    });
    dmInstallation = openControlInstallation({
      infraDir: infra,
      role: "data-manager",
      serviceIds: ["data-manager", "motis", "motis-staging", "motis-feed-proxy"],
    });
    writeFileSync(
      join(infra, "transitous.lock.json"),
      JSON.stringify({
        ref: `main@${sha}`,
        submodules: { "transitland-atlas": atlasSha },
        lockedAt: "2026-10-23T00:00:00.000Z",
        lockedBy: "fixture",
      }),
    );
    writeFileSync(
      join(infra, "gbfs-catalog.lock.json"),
      JSON.stringify({
        schemaVersion: 1,
        source: "mobilitydata-gbfs",
        commit: "b".repeat(40),
        url: `https://raw.githubusercontent.com/MobilityData/gbfs/${"b".repeat(40)}/systems.csv`,
        sha256: createHash("sha256").update(oldCsv).digest("hex"),
        lockedAt: "2026-10-23T00:00:00.000Z",
        lockedBy: "fixture",
      }),
    );
    await initializeManagedCatalogPins({ rootDir: root, installation: agentInstallation });
    const originalPins = readCatalogPinSet(root),
      token = "t".repeat(43),
      tokenFile = join(root, "dm-token");
    writeFileSync(tokenFile, token, { mode: 0o600 });
    agent = buildOpsAgentServer({
      tokens: { api: "a".repeat(43), "data-manager": token },
      runtime: createTransitousLockRuntime(createUnavailableRuntime(), { rootDir: root }),
      resourcePolicy: createRegistryResourcePolicy({
        serviceIds: ["motis"],
        integrationIds: [],
        trustedData: denyAllTrustedOpsData,
      }),
    });
    resetOpsClient(
      new OpsClient({ baseUrl: await agent.listen({ host: "127.0.0.1", port: 0 }), tokenFile }),
    );
    const fence = createDataConfigurationMaintenance(state.fixture.sql, dmInstallation);
    await fence.startup();
    installDataMutationAdmission(fence);
    const reviewer = createCatalogReviewService({
      dataDir,
      installation: dmInstallation,
      operationsPolicy: resolveOperationsProfile({
        profile: "regional-assisted",
        countries: ["de"],
      }),
    });
    const proposalId = "00000000-0000-4000-8000-000000000001",
      proposal = await reviewer.resolveCatalogProposal({ branch: "main", proposalId });
    expect(proposal.pins.transitous.ref).toBe(`main@${sha}`);
    expect(proposal.pins.gbfs.commit).toBe("c".repeat(40));
    expect(proposal.baseGenerationId).toBe(originalPins!.generationId);
    expect(readCatalogPinSet(root)).toEqual(originalPins);
    expect(git(catalog, ["rev-parse", "HEAD"])).toBe(sha);
    const page = reviewer.reviewPage(proposalId);
    expect(page.digest).toBe(proposal.diffDigest);
    expect(page.total).toBe(2);
    expect(page.rows.every((row) => row.region === "mobilitydata.de")).toBe(true);
    const requests = state.requests.length,
      retainedPath = join(infra, "catalog-pins/proposals", `${proposalId}.json`),
      bytes = readFileSync(retainedPath, "utf8");
    expect(await reviewer.resolveCatalogProposal({ branch: "main", proposalId })).toEqual(proposal);
    expect(state.requests).toHaveLength(requests);
    expect(readFileSync(retainedPath, "utf8")).toBe(bytes);
    expect(
      await state.fixture.sql`SELECT status FROM data_manager.jobs WHERE kind='transit-proposal'`,
    ).toEqual([{ status: "ok" }, { status: "ok" }]);
    const atlasRemote = join(root, "atlas-upstream.git"),
      atlasWork = join(root, "atlas-upstream-work"),
      catalogWork = join(root, "catalog-upstream-work");
    git(root, ["clone", "--bare", atlas, atlasRemote]);
    git(atlas, ["remote", "add", "origin", atlasRemote]);
    git(root, ["clone", atlasRemote, atlasWork]);
    writeFileSync(
      join(atlasWork, "feeds/bus.dmfr.json"),
      JSON.stringify({
        feeds: [
          {
            id: "auth",
            authorization: { type: "api-key" },
            license: { spdx_identifier: "CC-BY-4.0", attribution: "Operator" },
          },
        ],
      }),
    );
    git(atlasWork, ["add", "."]);
    git(atlasWork, ["commit", "-m", "Changed pinned license and credential requirement"]);
    git(atlasWork, ["push", "origin", "main"]);
    const nextAtlas = git(atlasWork, ["rev-parse", "HEAD"]);
    expect(() => git(atlas, ["cat-file", "-e", `${nextAtlas}^{commit}`])).toThrow();
    git(root, ["clone", remote, catalogWork]);
    git(catalogWork, ["checkout", "-b", "next"]);
    git(catalogWork, ["update-index", "--cacheinfo", `160000,${nextAtlas},transitland-atlas`]);
    git(catalogWork, ["commit", "-m", "Next Atlas gitlink"]);
    git(catalogWork, ["push", "origin", "next"]);
    const nextProposal = await reviewer.resolveCatalogProposal({
      branch: "next",
      proposalId: "00000000-0000-4000-8000-000000000002",
    });
    expect(nextProposal.pins.transitous.submodules["transitland-atlas"]).toBe(nextAtlas);
    expect(git(atlas, ["rev-parse", "HEAD"])).toBe(atlasSha);
    expect(git(catalog, ["rev-parse", "HEAD"])).toBe(sha);
    expect(git(atlas, ["cat-file", "-t", nextAtlas])).toBe("commit");
    expect(
      await inspectPinnedFeedCredentialKeys({
        catalogDir: catalog,
        transitousCommit: nextProposal.pins.transitous.ref.split("@").at(-1)!,
        atlasCommit: nextAtlas,
        git: async (args, cwd) => git(cwd, [...args]),
      }),
    ).toEqual(["de/bus"]);
    expect(
      reviewer
        .reviewPage(nextProposal.proposalId)
        .rows.some((row) => row.region.startsWith("atlas.") && row.fields.includes("license")),
    ).toBe(true);
    expect(readCatalogPinSet(root)).toEqual(originalPins);

    // Actual route/auth/codecs plus real durable SQL/runtime/dispatcher. This
    // negative validation deliberately has no installed host prerequisites;
    // it must finish as error without fabricating passed evidence or pins.
    const policy = resolveOperationsProfile({ profile: "regional-assisted", countries: ["de"] });
    const singleFlight = createSingleFlightController({
      db: drizzle(state.fixture.sql, {
        schema: {
          jobs,
          jobStages,
          feedState,
          offlinePackageJobs,
          offlinePackageJobOwners,
          offlinePackageArtifactReferences,
        },
      }),
      admissionSql: state.fixture.sql,
    });
    const dispatcher = createDataExecutionDispatcher({
      dataDir,
      state: new StateStore(dataDir),
      sql: state.fixture.sql,
      singleFlight,
      operationsPolicy: policy,
      runHardlinks: async () => {
        throw Error("Unexpected generation effect");
      },
    });
    const store = createPostgresDataExecutionStore(state.fixture.sql, {
      controlJournal: createDataExecutionControlJournal(dmInstallation, state.fixture.sql),
      configurationFence: fence,
    });
    const runtime = createDataExecutionRuntime({ store, dispatch: dispatcher.dispatch });
    const receiver = createDataExecutionReceiver({
      runtime,
      installation: dmInstallation,
      configurationFence: fence,
      dispatcher,
      operationsPolicy: policy,
    });
    const api = Fastify(),
      serviceToken = "catalog-service-fixture-token";
    registerAuth(api, serviceToken, { executionReceiver: () => receiver });
    registerApi(api, {
      dataDir,
      operationsPolicy: policy,
      singleFlight,
      catalogReview: reviewer,
      executionReceiver: receiver,
    });
    const headers = { authorization: `Bearer ${serviceToken}` };
    const oldTwoSlot = process.env.MOTIS_TWO_SLOT;
    process.env.MOTIS_TWO_SLOT = "false";
    try {
      const read = await api.inject({
        method: "GET",
        url: `/transit/pins?proposalId=${proposalId}`,
        headers,
      });
      expect(read.statusCode).toBe(200);
      expect(read.json()).toMatchObject({
        catalogRevisionId: originalPins!.generationId,
        proposal: { proposalId },
        diff: { total: 2 },
        validationEligible: false,
        execution: null,
      });
      const deadline = Date.now() + 120000,
        key = createControlRootOperationKey({ notAfter: deadline, nonce: Buffer.alloc(16, 9) });
      const accepted = await api.inject({
        method: "POST",
        url: "/executions",
        headers,
        payload: {
          input: { kind: "catalog.validate", proposalId, countries: ["de"] },
          operationKey: key,
          requestedDeadlineAt: deadline,
        },
      });
      expect(accepted.statusCode).toBe(202);
      const id = accepted.json().id;
      await vi.waitFor(async () => expect((await receiver.inspect(id))?.status).toBe("error"), {
        timeout: 10000,
        interval: 50,
      });
      const failed = await api.inject({
        method: "GET",
        url: `/transit/pins?proposalId=${proposalId}`,
        headers,
      });
      expect(failed.statusCode).toBe(200);
      expect(failed.json()).toMatchObject({
        validationEligible: false,
        validation: null,
        execution: { id, kind: "catalog.validate", status: "error" },
      });
      expect(readCatalogPinSet(root)).toEqual(originalPins);
      expect(await receiver.lookup(key)).toMatchObject({ id, status: "error" });
    } finally {
      if (oldTwoSlot === undefined) delete process.env.MOTIS_TWO_SLOT;
      else process.env.MOTIS_TWO_SLOT = oldTwoSlot;
      await api.close();
      await runtime.close();
    }
  },
  90000,
);
