import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  type CommunityRepositoryClone,
  CommunityRepositoryStore,
  communityRepositoryId,
} from "./community-repositories";
import { createTrustedConfigurationAuthorityLoader } from "./trusted-configuration-authority";

const URL = "https://github.com/example/community-services";
const REPOSITORY = communityRepositoryId(URL);
const FIRST = "1".repeat(40);
const SECOND = "2".repeat(40);
const RECOVERY = {
  selectionBefore: ["postgis"],
  touchedServiceIds: ["community-live"],
  previouslyEnabledServiceIds: [],
};

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function builtIn(id: string): services.LoadedService {
  return {
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "built-in",
      container: { image: `example/${id}`, tag: "1" },
    },
    directory: `/trusted/${id}`,
    isBuiltIn: true,
    enabled: true,
  };
}

function manifest(id: string, version: string, overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    id,
    name: id,
    version,
    quality: "community",
    container: {
      image: `registry.example.test/${id}`,
      tag: version,
      digest: `sha256:${"a".repeat(64)}`,
    },
    ...overrides,
  });
}

type Snapshot = { commit: string; files: Record<string, string> };

function fixture(snapshots: Record<string, Snapshot>) {
  const root = mkdtempSync(join(tmpdir(), "openmapx-community-repositories-"));
  roots.push(root);
  chmodSync(root, 0o755);
  mkdirSync(join(root, "services"), { mode: 0o755 });
  mkdirSync(join(root, "custom_integrations"), { mode: 0o755 });
  const clones: string[] = [];
  const clone: CommunityRepositoryClone = async ({ url, ref, targetDir }) => {
    clones.push(`${url}@${ref}`);
    const snapshot = snapshots[ref];
    if (!snapshot) throw new Error(`unknown ref ${ref}`);
    for (const [path, contents] of Object.entries(snapshot.files)) {
      mkdirSync(dirname(join(targetDir, path)), { recursive: true, mode: 0o775 });
      writeFileSync(join(targetDir, path), contents, { mode: 0o664 });
    }
    return { directory: targetDir, commit: snapshot.commit };
  };
  const loadAuthority = createTrustedConfigurationAuthorityLoader({
    rootDir: root,
    builtInServices: [builtIn("postgis")],
  });
  const store = new CommunityRepositoryStore({
    rootDir: root,
    uid: process.geteuid?.() ?? 0,
    loadAuthority,
    clone,
  });
  const community = join(root, "services", ".community");
  return { root, community, store, loadAuthority, clones };
}

const signal = () => new AbortController().signal;
const firstSnapshot = {
  commit: FIRST,
  files: { "services/live/service.json": manifest("community-live", "1.0.0") },
};
const secondSnapshot = {
  commit: SECOND,
  files: { "services/live/service.json": manifest("community-live", "2.0.0") },
};

function publish(store: CommunityRepositoryStore, commit: string, extensionId = "live-bundle") {
  return store.publish(
    { kind: "serviceRepository.publish", url: URL, commit, extensionId, recovery: RECOVERY },
    signal(),
  );
}

function installedVersion(community: string): string {
  return JSON.parse(
    readFileSync(join(community, REPOSITORY, "services", "live", "service.json"), "utf8"),
  ).version;
}

describe("community repository store", () => {
  it("inspects a repository without installing it and explains problems", async () => {
    const { store, community } = fixture({
      HEAD: firstSnapshot,
      broken: {
        commit: SECOND,
        files: {
          "a/service.json": manifest("postgis", "1.0.0"),
          "b/service.json": manifest("unpinned", "1.0.0", {
            container: { image: "registry.example.test/unpinned", tag: "1" },
          }),
        },
      },
    });

    const inspected = await store.inspect(
      { kind: "serviceRepository.inspect", url: URL },
      signal(),
    );
    expect(inspected).toMatchObject({
      url: URL,
      repository: REPOSITORY,
      commit: FIRST,
      valid: true,
      problems: [],
      services: [{ path: "services/live", manifest: { id: "community-live" } }],
    });

    const broken = await store.inspect(
      { kind: "serviceRepository.inspect", url: URL, ref: "broken" },
      signal(),
    );
    expect(broken.valid).toBe(false);
    expect(broken.problems).toEqual(
      expect.arrayContaining([
        expect.stringContaining("must pin its container image by sha256 digest"),
        'Service id "postgis" is already used by another service',
      ]),
    );
    // Nothing was installed and no staging clone remains.
    expect(readdirSync(community)).toEqual([]);
  });

  it("refuses manifests too large for the installed-services report", async () => {
    const large = {
      commit: FIRST,
      files: Object.fromEntries(
        Array.from({ length: 4 }, (_, index) => [
          `s${index}/service.json`,
          manifest(`large-${index}`, "1.0.0", { description: "x".repeat(250_000) }),
        ]),
      ),
    };
    const { store, community } = fixture({ HEAD: large, [FIRST]: large });

    const inspected = await store.inspect(
      { kind: "serviceRepository.inspect", url: URL },
      signal(),
    );
    expect(inspected.valid).toBe(false);
    expect(inspected.problems).toEqual([
      `Installed community service manifests would exceed ${768 * 1024} bytes`,
    ]);
    expect(inspected.services).toEqual([]);
    await expect(publish(store, FIRST)).rejects.toThrow("could not be installed");
    expect(readdirSync(community)).toEqual([]);
  });

  it("falls back to the inspected ref when the host refuses a bare commit", async () => {
    const { store, clones } = fixture({ v1: firstSnapshot, v2: secondSnapshot });
    const viaRef = (ref: string) =>
      store.publish(
        {
          kind: "serviceRepository.publish",
          url: URL,
          commit: FIRST,
          ref,
          extensionId: "live-bundle",
          recovery: RECOVERY,
        },
        signal(),
      );

    // The ref has moved on since the inspection: refused.
    await expect(viaRef("v2")).rejects.toThrow("could not be installed");
    await expect(viaRef("v1")).resolves.toMatchObject({ commit: FIRST });
    expect(clones).toEqual([`${URL}@${FIRST}`, `${URL}@v2`, `${URL}@${FIRST}`, `${URL}@v1`]);
  });

  it("refuses to adopt a checkout no extension installed", async () => {
    const { store, community } = fixture({ [FIRST]: firstSnapshot });
    mkdirSync(join(community, REPOSITORY, "services", "live"), { recursive: true, mode: 0o755 });
    writeFileSync(
      join(community, REPOSITORY, "services", "live", "service.json"),
      manifest("community-live", "0.9.0"),
    );

    await expect(publish(store, FIRST)).rejects.toThrow("belongs to another extension");
    await expect(
      store.remove({
        kind: "serviceRepository.remove",
        repository: REPOSITORY,
        extensionId: "live-bundle",
      }),
    ).rejects.toThrow("belongs to another extension");
    expect(readdirSync(community)).toEqual([REPOSITORY]);
  });

  it("installs a commit, keeps the previous checkout until commit, then drops it", async () => {
    const { store, community, loadAuthority } = fixture({
      [FIRST]: firstSnapshot,
      [SECOND]: secondSnapshot,
    });

    const first = await publish(store, FIRST);
    expect(first).toMatchObject({
      repository: REPOSITORY,
      commit: FIRST,
      serviceIds: ["community-live"],
    });
    expect((await loadAuthority()).services.map((service) => service.manifest.id).sort()).toEqual([
      "community-live",
      "postgis",
    ]);
    const listed = await store.list();
    expect(listed.repositories).toEqual([
      {
        repository: REPOSITORY,
        url: URL,
        commit: FIRST,
        extensionId: "live-bundle",
        pending: {
          transactionId: first.transactionId,
          phase: "published",
          previousCommit: null,
          recovery: RECOVERY,
        },
      },
    ]);
    expect(listed.services).toEqual([
      expect.objectContaining({
        repository: REPOSITORY,
        manifest: expect.objectContaining({ id: "community-live" }),
      }),
    ]);
    await expect(
      store.settle({
        kind: "serviceRepository.settle",
        repository: REPOSITORY,
        transactionId: first.transactionId,
        outcome: "commit",
      }),
    ).resolves.toEqual({ repository: REPOSITORY, outcome: "commit", changed: true });

    const second = await publish(store, SECOND);
    expect(installedVersion(community)).toBe("2.0.0");
    expect(existsSync(join(community, `.backup-${REPOSITORY}-${second.transactionId}`))).toBe(true);
    expect((await store.list()).repositories[0]?.pending?.previousCommit).toBe(FIRST);
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: second.transactionId,
      outcome: "commit",
    });
    expect(readdirSync(community).sort()).toEqual([`.repository-${REPOSITORY}.json`, REPOSITORY]);
    expect((await store.list()).repositories[0]).toMatchObject({ commit: SECOND, pending: null });
    // Settling the same transaction again changes nothing.
    await expect(
      store.settle({
        kind: "serviceRepository.settle",
        repository: REPOSITORY,
        transactionId: second.transactionId,
        outcome: "rollback",
      }),
    ).resolves.toMatchObject({ changed: false });
  });

  it("rolls an update back to the previous checkout and a new install back to nothing", async () => {
    const { store, community } = fixture({ [FIRST]: firstSnapshot, [SECOND]: secondSnapshot });
    const first = await publish(store, FIRST);
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: first.transactionId,
      outcome: "commit",
    });

    const update = await publish(store, SECOND);
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: update.transactionId,
      outcome: "rollback",
    });
    expect(installedVersion(community)).toBe("1.0.0");
    // The recovery note stays until the API releases it, and blocks changes.
    expect((await store.list()).repositories[0]).toMatchObject({
      commit: FIRST,
      pending: { transactionId: update.transactionId, phase: "rolledBack", recovery: RECOVERY },
    });
    await expect(publish(store, SECOND)).rejects.toThrow("Operations service is busy");
    // An agent restart keeps the note.
    await store.recover();
    expect((await store.list()).repositories[0]?.pending?.phase).toBe("rolledBack");
    await expect(
      store.settle({
        kind: "serviceRepository.settle",
        repository: REPOSITORY,
        transactionId: update.transactionId,
        outcome: "commit",
      }),
    ).rejects.toThrow("could not be installed");
    await expect(
      store.settle({
        kind: "serviceRepository.settle",
        repository: REPOSITORY,
        transactionId: update.transactionId,
        outcome: "rollback",
      }),
    ).resolves.toMatchObject({ changed: false });
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: update.transactionId,
      outcome: "release",
    });
    expect((await store.list()).repositories[0]).toMatchObject({ commit: FIRST, pending: null });

    await store.remove(
      {
        kind: "serviceRepository.remove",
        repository: REPOSITORY,
        extensionId: "live-bundle",
      },
      signal(),
      { inspectOwnedServices: async () => [] },
    );
    const fresh = await publish(store, SECOND);
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: fresh.transactionId,
      outcome: "rollback",
    });
    expect(readdirSync(community)).toEqual([`.repository-${REPOSITORY}.json`]);
    expect((await store.list()).repositories).toEqual([
      expect.objectContaining({
        url: null,
        extensionId: null,
        pending: expect.objectContaining({ phase: "rolledBack" }),
      }),
    ]);
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: fresh.transactionId,
      outcome: "release",
    });
    expect(readdirSync(community)).toEqual([]);
  });

  it("refuses changes while a transaction is pending or from another extension", async () => {
    const { store } = fixture({ [FIRST]: firstSnapshot, [SECOND]: secondSnapshot });
    const first = await publish(store, FIRST);
    await expect(publish(store, SECOND)).rejects.toThrow("Operations service is busy");
    await expect(
      store.remove({
        kind: "serviceRepository.remove",
        repository: REPOSITORY,
        extensionId: "live-bundle",
      }),
    ).rejects.toThrow("Operations service is busy");
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: first.transactionId,
      outcome: "commit",
    });
    await expect(publish(store, SECOND, "other-bundle")).rejects.toThrow(
      "The repository belongs to another extension",
    );
    await expect(
      store.remove({
        kind: "serviceRepository.remove",
        repository: REPOSITORY,
        extensionId: "other-bundle",
      }),
    ).rejects.toThrow("The repository belongs to another extension");
    await expect(
      store.remove(
        {
          kind: "serviceRepository.remove",
          repository: REPOSITORY,
          extensionId: "live-bundle",
        },
        signal(),
        { inspectOwnedServices: async () => [] },
      ),
    ).resolves.toEqual({ repository: REPOSITORY, removed: true });
  });

  it("installs nothing when the fetched commit or its services do not match", async () => {
    const { store, community } = fixture({
      [FIRST]: { ...firstSnapshot, commit: SECOND },
      [SECOND]: {
        commit: SECOND,
        files: { "service.json": manifest("postgis", "1.0.0") },
      },
    });
    await expect(publish(store, FIRST)).rejects.toThrow("The repository could not be installed");
    await expect(publish(store, SECOND)).rejects.toThrow("The repository could not be installed");
    expect(readdirSync(community)).toEqual([]);
  });

  it("recovers an interrupted transaction and drops staging and orphaned backups", async () => {
    const { store, community, root, loadAuthority } = fixture({
      [FIRST]: firstSnapshot,
      [SECOND]: secondSnapshot,
    });
    const first = await publish(store, FIRST);
    await store.settle({
      kind: "serviceRepository.settle",
      repository: REPOSITORY,
      transactionId: first.transactionId,
      outcome: "commit",
    });
    // Simulate a crash after both renames but before the record was marked
    // published: the new checkout is live, the backup holds the old one.
    const update = await publish(store, SECOND);
    const recordPath = join(community, `.repository-${REPOSITORY}.json`);
    const record = JSON.parse(readFileSync(recordPath, "utf8"));
    writeFileSync(
      recordPath,
      JSON.stringify({
        ...record,
        commit: FIRST,
        pending: { ...record.pending, phase: "prepared" },
      }),
    );
    mkdirSync(join(community, `.stage-${"c".repeat(24)}`), { mode: 0o755 });
    const orphan = join(community, `.backup-${REPOSITORY}-txn1_${"d".repeat(24)}`);
    mkdirSync(orphan, { mode: 0o755 });

    const restarted = new CommunityRepositoryStore({
      rootDir: root,
      uid: process.geteuid?.() ?? 0,
      loadAuthority,
    });
    await restarted.recover();
    expect(installedVersion(community)).toBe("1.0.0");
    expect(readdirSync(community).sort()).toEqual([`.repository-${REPOSITORY}.json`, REPOSITORY]);
    expect((await restarted.list()).repositories[0]).toMatchObject({
      commit: FIRST,
      pending: null,
    });
    expect(update.transactionId).not.toBe(first.transactionId);
  });

  it("keeps a published transaction for the API to settle after a restart", async () => {
    const { store, community, root, loadAuthority } = fixture({ [FIRST]: firstSnapshot });
    const first = await publish(store, FIRST);
    const restarted = new CommunityRepositoryStore({
      rootDir: root,
      uid: process.geteuid?.() ?? 0,
      loadAuthority,
    });
    await restarted.recover();
    expect((await restarted.list()).repositories[0]?.pending?.transactionId).toBe(
      first.transactionId,
    );
    expect(installedVersion(community)).toBe("1.0.0");
  });
});
