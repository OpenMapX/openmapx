import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { services } from "@openmapx/core/server";
import { packageIntegration } from "@openmapx/integration-framework/installer";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommunityRepositoryClone,
  CommunityRepositoryStore,
  communityRepositoryId,
} from "./community-repositories";
import { IntegrationStore } from "./integration-store";
import { createOwnedServiceResolver } from "./owned-services";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

const URL = "https://github.com/example/community-services";
const REPOSITORY = communityRepositoryId(URL);
const COMMIT = "1".repeat(40);
const NEXT = "2".repeat(40);
const RECOVERY = {
  selectionBefore: ["postgis"],
  touchedServiceIds: [],
  previouslyEnabledServiceIds: [],
};
const uid = process.geteuid?.() ?? 0;
const signal = () => new AbortController().signal;
const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serviceManifest(version: string) {
  return JSON.stringify({
    id: "community-live",
    name: "community-live",
    version,
    quality: "community",
    container: {
      image: "registry.example.test/community-live",
      tag: version,
      digest: `sha256:${"a".repeat(64)}`,
    },
  });
}

/**
 * A checkout as an earlier release left it: both stores in the checkout,
 * filled by the agent's own store code, with its records.
 */
function earlierRelease() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-stores-"));
  roots.push(root);
  chmodSync(root, 0o755);
  // The whole checkout is mounted, as this release's manifest has it.
  mkdirSync(join(root, "services"));
  const infraDir = join(root, "infra", "docker");
  mkdirSync(services.agentStatePaths(infraDir).directory, { recursive: true, mode: 0o700 });
  const legacy = services.legacyAgentStorePaths(infraDir);
  const artifacts = new Map<string, string>();
  const integrations = (directory?: string) =>
    new IntegrationStore({
      rootDir: root,
      ...(directory ? { directory } : {}),
      uid,
      builtInIds: () => new Set(["routing"]),
      download: async ({ url, destination }) => {
        const path = artifacts.get(url.href);
        if (!path) throw new Error("unreachable");
        copyFileSync(path, destination);
      },
    });
  const snapshots: Record<string, { commit: string; version: string }> = {
    [COMMIT]: { commit: COMMIT, version: "1.0.0" },
    [NEXT]: { commit: NEXT, version: "2.0.0" },
    HEAD: { commit: COMMIT, version: "1.0.0" },
  };
  const clone: CommunityRepositoryClone = async ({ ref, targetDir }) => {
    const snapshot = snapshots[ref];
    if (!snapshot) throw new Error(`unknown ref ${ref}`);
    const path = join(targetDir, "services", "live", "service.json");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, serviceManifest(snapshot.version));
    return { directory: targetDir, commit: snapshot.commit };
  };
  const loadAuthority = createTrustedConfigurationAuthorityLoader({
    rootDir: root,
    builtInServices: [],
  });
  const repositories = (directory?: string) =>
    new CommunityRepositoryStore({
      rootDir: root,
      ...(directory ? { directory } : {}),
      uid,
      loadAuthority,
      clone,
    });
  const artifact = async (id: string, region = "eu") => {
    const source = mkdtempSync(join(tmpdir(), "openmapx-integration-source-"));
    roots.push(source);
    writeFileSync(
      join(source, "manifest.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        domains: ["map-overlay"],
        quality: "community",
        platform: "1.0",
        configSchema: { type: "object", properties: { region: { enum: [region] } } },
      }),
    );
    const outFile = join(source, "..", `${id}-${region}-${Math.random()}.tar.gz`);
    roots.push(outFile);
    await packageIntegration({ rootDir: root, source, outFile });
    const url = `https://artifacts.example.test/${id}/${sha256(readFileSync(outFile)).slice(0, 8)}.tar.gz`;
    artifacts.set(url, outFile);
    return { kind: "artifact" as const, url, sha256: sha256(readFileSync(outFile)) };
  };
  const install = async (store: IntegrationStore, id: string, region = "eu") => {
    const published = await store.publish(
      {
        kind: "catalogIntegration.publish",
        integrationId: id,
        source: await artifact(id, region),
        extensionId: "bundle",
      },
      signal(),
    );
    return published;
  };
  return { root, infraDir, legacy, integrations, repositories, install, loadAuthority };
}

async function settleIntegration(store: IntegrationStore, id: string, transactionId: string) {
  await store.settle({
    kind: "catalogIntegration.settle",
    integrationId: id,
    transactionId,
    outcome: "commit",
  });
}

async function installRepository(store: CommunityRepositoryStore, commit = COMMIT) {
  const published = await store.publish(
    {
      kind: "serviceRepository.publish",
      url: URL,
      commit,
      extensionId: "bundle",
      recovery: RECOVERY,
    },
    signal(),
  );
  return published;
}

const mode = (path: string) => lstatSync(path).mode & 0o777;

describe("copying the agent's stores out of the checkout", () => {
  it("copies an installed integration and a community repository, verified, and uses only the copies", async () => {
    const f = earlierRelease();
    const oldIntegrations = f.integrations(f.legacy.customIntegrations);
    const radar = await f.install(oldIntegrations, "weather-radar");
    await settleIntegration(oldIntegrations, "weather-radar", radar.transactionId);
    const oldRepositories = f.repositories(f.legacy.community);
    const repository = await installRepository(oldRepositories);
    await oldRepositories.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: repository.transactionId,
      outcome: "commit",
    });
    const before = readFileSync(
      join(f.legacy.customIntegrations, "weather-radar", "manifest.json"),
    );

    const migration = services.prepareAgentStores(f.infraDir, { uid });

    expect(migration?.integrations).toEqual({
      copied: ["weather-radar"],
      refused: [],
      unrecorded: [],
    });
    expect(migration?.repositories).toEqual({ copied: [REPOSITORY], refused: [], unrecorded: [] });
    const paths = services.agentStatePaths(f.infraDir);
    expect(mode(paths.community)).toBe(0o700);
    expect(mode(paths.customIntegrations)).toBe(0o700);
    // Copied, not moved: an earlier release still finds its stores.
    expect(
      readFileSync(join(f.legacy.customIntegrations, "weather-radar", "manifest.json")),
    ).toEqual(before);
    expect(
      existsSync(join(f.legacy.community, REPOSITORY, "services", "live", "service.json")),
    ).toBe(true);
    expect(readdirSync(paths.directory).some((name) => name.startsWith(".stores-copy-"))).toBe(
      false,
    );
    // Once only.
    expect(services.prepareAgentStores(f.infraDir, { uid })).toBeNull();

    // The agent and its fixed CLI read the copies.
    expect([...services.loadTrustedIntegrationSchemas(f.root).keys()]).toEqual(["weather-radar"]);
    expect((await f.loadAuthority()).services.map((service) => service.manifest.id)).toEqual([
      "community-live",
    ]);
    const integrations = f.integrations();
    const repositories = f.repositories();
    expect((await integrations.list()).integrations).toMatchObject([
      { integrationId: "weather-radar", status: "ok" },
    ]);
    const listed = await repositories.list();
    expect(listed.services.map((service) => service.directory)).toEqual([
      join(paths.community, REPOSITORY, "services", "live"),
    ]);

    // And removes there, leaving the earlier copies as they were at the copy.
    await integrations.remove({
      kind: "catalogIntegration.remove",
      integrationId: "weather-radar",
      extensionId: "bundle",
    });
    const owned = createOwnedServiceResolver({
      stack: {
        infraDir: f.infraDir,
        composePath: join(
          f.infraDir,
          services.CURRENT_CONFIGURATION,
          "docker-compose.generated.yml",
        ),
        composeReleasePath: services.releaseStatePaths(f.infraDir).overlay,
      },
      loadAuthority: f.loadAuthority,
      // External Docker observation: no running or stopped containers remain.
      // Keep the actual provenance/inventory parser in the removal boundary.
      execFile: async (file, args) => {
        expect(file).toBe("docker");
        expect(args.slice(0, 3)).toEqual(["container", "ls", "--all"]);
        return { stdout: "", stderr: "" };
      },
    });
    await repositories.remove(
      {
        kind: "serviceRepository.remove",
        repository: REPOSITORY,
        extensionId: "bundle",
      },
      signal(),
      owned,
      ["community-live"],
    );
    expect(existsSync(join(paths.customIntegrations, "weather-radar"))).toBe(false);
    expect(existsSync(join(paths.community, REPOSITORY))).toBe(false);
    expect(services.loadTrustedIntegrationSchemas(f.root).size).toBe(0);
    expect(existsSync(join(f.legacy.customIntegrations, "weather-radar", "manifest.json"))).toBe(
      true,
    );
    expect(existsSync(join(f.legacy.community, REPOSITORY))).toBe(true);
  });

  it("refuses what no longer matches its record and leaves out what has none, and keeps saying so", async () => {
    const f = earlierRelease();
    const store = f.integrations(f.legacy.customIntegrations);
    const radar = await f.install(store, "weather-radar");
    await settleIntegration(store, "weather-radar", radar.transactionId);
    const tides = await f.install(store, "tides");
    await settleIntegration(store, "tides", tides.transactionId);
    appendFileSync(join(f.legacy.customIntegrations, "tides", "manifest.json"), " ");
    mkdirSync(join(f.legacy.customIntegrations, "hand-placed"));
    writeFileSync(join(f.legacy.customIntegrations, "hand-placed", "manifest.json"), "{}");
    const repositories = f.repositories(f.legacy.community);
    const repository = await installRepository(repositories);
    await repositories.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: repository.transactionId,
      outcome: "commit",
    });
    writeFileSync(
      join(f.legacy.community, REPOSITORY, "services", "live", "service.json"),
      serviceManifest("9.9.9"),
    );
    mkdirSync(join(f.legacy.community, "0123456789abcdef"));

    const migration = services.prepareAgentStores(f.infraDir, { uid });

    expect(migration?.integrations).toEqual({
      copied: ["weather-radar"],
      refused: [{ id: "tides", reason: "its files no longer match the agent's install record" }],
      unrecorded: ["hand-placed"],
    });
    expect(migration?.repositories).toEqual({
      copied: [],
      refused: [
        {
          id: REPOSITORY,
          reason: "its checkout no longer matches the service manifests the agent recorded",
        },
      ],
      unrecorded: ["0123456789abcdef"],
    });
    const paths = services.agentStatePaths(f.infraDir);
    expect(readdirSync(paths.customIntegrations)).toEqual(["weather-radar"]);
    expect(readdirSync(paths.community)).toEqual([]);

    const leftBehind = services.agentStoresLeftBehind(f.infraDir);
    expect(leftBehind).toEqual([
      "The integration tides in custom_integrations was not copied into the operations agent's state: its files no longer match the agent's install record. Install it again through the admin panel, then delete custom_integrations/tides.",
      "The integration hand-placed in custom_integrations was not copied into the operations agent's state: the agent holds no record of it. Install it through the admin panel if you need it, then delete custom_integrations/hand-placed.",
      `The community repository ${REPOSITORY} in services/.community was not copied into the operations agent's state: its checkout no longer matches the service manifests the agent recorded. Install it again through the admin panel, then delete services/.community/${REPOSITORY}.`,
      "The community repository 0123456789abcdef in services/.community was not copied into the operations agent's state: the agent holds no record of it. Install it through the admin panel if you need it, then delete services/.community/0123456789abcdef.",
    ]);
    // Until the operator deletes what was left behind.
    rmSync(join(f.legacy.customIntegrations, "hand-placed"), { recursive: true });
    rmSync(join(f.legacy.community, "0123456789abcdef"), { recursive: true });
    expect(services.agentStoresLeftBehind(f.infraDir)).toHaveLength(2);
  });

  it("carries only what a repository's record trusts, and the record it validated", async () => {
    const f = earlierRelease();
    const repositories = f.repositories(f.legacy.community);
    const repository = await installRepository(repositories);
    await repositories.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: repository.transactionId,
      outcome: "commit",
    });
    // Planted beside the recorded manifest in a checkout others could write.
    const checkout = join(f.legacy.community, REPOSITORY);
    writeFileSync(join(checkout, "services", "live", "run.sh"), "#!/bin/sh\n");
    symlinkSync("/etc/passwd", join(checkout, "passwd"));
    const validated = services.readCommunityRepositoryRecord(f.legacy.community, REPOSITORY, uid);

    expect(services.prepareAgentStores(f.infraDir, { uid })?.repositories.copied).toEqual([
      REPOSITORY,
    ]);

    const store = services.agentStatePaths(f.infraDir).community;
    const files = readdirSync(join(store, REPOSITORY), { recursive: true, encoding: "utf8" });
    expect(files.sort()).toEqual(["services", "services/live", "services/live/service.json"]);
    expect(services.readCommunityRepositoryRecord(store, REPOSITORY, uid)).toEqual(validated);
  });

  it("refuses a repository record that is a link, without reading through it", async () => {
    const f = earlierRelease();
    const repositories = f.repositories(f.legacy.community);
    const repository = await installRepository(repositories);
    await repositories.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: repository.transactionId,
      outcome: "commit",
    });
    const recordPath = join(f.legacy.community, services.communityRecordFileName(REPOSITORY));
    const elsewhere = join(f.root, "elsewhere.json");
    copyFileSync(recordPath, elsewhere);
    rmSync(recordPath);
    symlinkSync(elsewhere, recordPath);

    expect(services.prepareAgentStores(f.infraDir, { uid })?.repositories).toEqual({
      copied: [],
      refused: [{ id: REPOSITORY, reason: "its record is not one the agent wrote" }],
      unrecorded: [],
    });
    expect(readdirSync(services.agentStatePaths(f.infraDir).community)).toEqual([]);
  });

  it("carries an unfinished change, with the copy it replaced, so the agent can still settle it", async () => {
    const f = earlierRelease();
    const store = f.integrations(f.legacy.customIntegrations);
    const first = await f.install(store, "weather-radar", "eu");
    await settleIntegration(store, "weather-radar", first.transactionId);
    // A second version published but not yet settled: its backup is kept.
    const second = await f.install(store, "weather-radar", "us");

    const migration = services.prepareAgentStores(f.infraDir, { uid });
    expect(migration?.integrations.copied).toEqual(["weather-radar"]);
    const paths = services.agentStatePaths(f.infraDir);
    expect(readdirSync(paths.customIntegrations).sort()).toEqual([
      `.agent-backup-weather-radar-${second.transactionId}`,
      "weather-radar",
    ]);

    // Rolled back in the new location, the first version comes back.
    await f.integrations().settle({
      kind: "catalogIntegration.settle",
      integrationId: "weather-radar",
      transactionId: second.transactionId,
      outcome: "rollback",
    });
    const schema = services.loadTrustedIntegrationSchemas(f.root).get("weather-radar") as {
      properties: { region: { enum: string[] } };
    };
    expect(schema.properties.region.enum).toEqual(["eu"]);
  });

  it("installs after the copy only in the new store, where app-api's new mount finds it", async () => {
    // A panel self-update: the new agent copied the stores at its start, and
    // app-api still runs with its earlier mount of the checkout.
    const f = earlierRelease();
    const earlier = f.integrations(f.legacy.customIntegrations);
    const radar = await f.install(earlier, "weather-radar");
    await settleIntegration(earlier, "weather-radar", radar.transactionId);
    services.prepareAgentStores(f.infraDir, { uid });

    const store = f.integrations();
    const tides = await f.install(store, "tides");
    await settleIntegration(store, "tides", tides.transactionId);

    const paths = services.agentStatePaths(f.infraDir);
    expect(readdirSync(paths.customIntegrations).sort()).toEqual(["tides", "weather-radar"]);
    // The earlier mount keeps what it had, so app-api keeps loading it until
    // its render recreates it with the new mount, which then holds both.
    expect(readdirSync(f.legacy.customIntegrations)).toEqual(["weather-radar"]);
    expect([...services.loadTrustedIntegrationSchemas(f.root).keys()].sort()).toEqual([
      "tides",
      "weather-radar",
    ]);
    // A later render or agent start copies nothing again.
    expect(services.prepareAgentStores(f.infraDir, { uid })).toBeNull();
    expect(readdirSync(paths.customIntegrations).sort()).toEqual(["tides", "weather-radar"]);
  });

  it("keeps a store a stopped copy already filled, and copies only the other", async () => {
    const f = earlierRelease();
    const earlier = f.integrations(f.legacy.customIntegrations);
    const radar = await f.install(earlier, "weather-radar");
    await settleIntegration(earlier, "weather-radar", radar.transactionId);
    const repositories = f.repositories(f.legacy.community);
    const repository = await installRepository(repositories);
    await repositories.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: repository.transactionId,
      outcome: "commit",
    });
    // A copy that put the integration store in place and stopped before
    // writing its record.
    const paths = services.agentStatePaths(f.infraDir);
    mkdirSync(join(paths.customIntegrations, "tides"), { recursive: true, mode: 0o755 });
    chmodSync(paths.customIntegrations, 0o755);

    const migration = services.prepareAgentStores(f.infraDir, { uid });

    expect(migration?.integrations).toEqual({ copied: [], refused: [], unrecorded: [] });
    expect(migration?.repositories.copied).toEqual([REPOSITORY]);
    expect(readdirSync(paths.customIntegrations)).toEqual(["tides"]);
    expect(mode(paths.customIntegrations)).toBe(0o700);
    expect(services.prepareAgentStores(f.infraDir, { uid })).toBeNull();
  });

  it("starts empty stores when the checkout has none, as on openmapx.com", () => {
    const f = earlierRelease();
    const migration = services.prepareAgentStores(f.infraDir, { uid });
    expect(migration).toMatchObject({
      integrations: { copied: [], refused: [], unrecorded: [] },
      repositories: { copied: [], refused: [], unrecorded: [] },
    });
    const paths = services.agentStatePaths(f.infraDir);
    expect(readdirSync(paths.customIntegrations)).toEqual([]);
    expect(readdirSync(paths.community)).toEqual([]);
    expect(services.describeAgentStoresMigration(migration, f.infraDir)).toEqual([]);
  });
});
