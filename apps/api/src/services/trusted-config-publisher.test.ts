import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES } from "@openmapx/core/ops";
import { afterEach, describe, expect, it } from "vitest";
import { initializeTrustedSnapshotDirectory } from "../../../ops-agent/src/trusted-config-source";
import {
  consumePublishedTrustedConfiguration,
  publishTrustedConfigurationSnapshot,
  type SnapshotPublishDependencies,
} from "./trusted-config-publisher";

const roots: string[] = [];
const token = Buffer.alloc(32, 0x37).toString("base64url");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-trusted-publisher-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

describe("trusted configuration snapshot publisher", () => {
  it("durably publishes one group-confidential immutable final file", async () => {
    const root = directory();
    const published = await publishTrustedConfigurationSnapshot({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
      payload: {
        domain: "maps.example.test",
        selectedRoots: ["redis"],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      now: () => Date.parse("2026-08-24T08:00:00.000Z"),
      nonce: () => "nonce_0123456789abcdef",
    });
    expect(readdirSync(root)).toEqual([`${published.revisionId}.json`]);
    expect(readFileSync(join(root, `${published.revisionId}.json`))).toEqual(published.bytes);
    expect(published.mode).toBe(0o600);
    expect(published.operation).toEqual({
      kind: "stack.render",
      revisionId: published.revisionId,
    });
    expect(Object.keys(published.operation).sort()).toEqual(["kind", "revisionId"]);
  });

  it("never exposes a final snapshot when interrupted before atomic rename", async () => {
    const root = directory();
    const dependencies: Partial<SnapshotPublishDependencies> = {
      beforeRename: async () => {
        throw new Error("simulated interruption");
      },
    };
    await expect(
      publishTrustedConfigurationSnapshot(
        {
          directory: root,
          token,
          ownerUid: statSync(root).uid,
          ownerGid: statSync(root).gid,
          operationKey: "opk1_0123456789abcdef",
          operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
          payload: {
            domain: "maps.example.test",
            selectedRoots: [],
            serviceConfigs: [],
            integrationConfigs: [],
            serviceSecrets: [],
          },
          nonce: () => "nonce_0123456789abcdef",
        },
        dependencies,
      ),
    ).rejects.toThrow("Trusted configuration snapshot publish failed");
    expect(readdirSync(root).filter((name) => name.endsWith(".json"))).toEqual([]);
  });

  it("aborts only the exact inode and content-digest-bound published candidate", async () => {
    const root = directory();
    const published = await publishTrustedConfigurationSnapshot({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
      payload: {
        domain: "maps.example.test",
        selectedRoots: [],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      nonce: () => "nonce_0123456789abcdef",
    });
    const path = join(root, `${published.revisionId}.json`);
    expect(existsSync(path)).toBe(true);
    await published.abort();
    await published.abort();
    expect(existsSync(path)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("caps fresh ready candidates before a 129th failed submission can brick restart", async () => {
    const root = directory();
    const make = (index: number) =>
      publishTrustedConfigurationSnapshot({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        now: () => Date.parse("2026-08-24T08:00:00.000Z"),
        nonce: () => `nonce_${index.toString().padStart(16, "0")}`,
      });
    for (let index = 0; index < 128; index += 1) await make(index);
    await expect(make(128)).rejects.toThrow("Trusted configuration snapshot publish failed");
    expect(readdirSync(root)).toHaveLength(128);
  }, 60_000);

  it("shares the exact claimed-plus-ready entry boundary with restart", async () => {
    const root = directory();
    const claimed = join(root, ".claimed");
    mkdirSync(claimed, { mode: 0o700 });
    const make = (index: number) =>
      publishTrustedConfigurationSnapshot({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        now: () => Date.parse("2026-08-24T08:00:00.000Z"),
        nonce: () => `nonce_${index.toString().padStart(16, "0")}`,
      });
    const journalRecords: Array<{
      operation: Awaited<ReturnType<typeof make>>["operation"];
      state: "running";
    }> = [];
    for (let index = 0; index < 128; index += 1) {
      const published = await make(index);
      if (index < 4) {
        renameSync(
          join(root, `${published.revisionId}.json`),
          join(claimed, `${published.revisionId}.json`),
        );
        journalRecords.push({ operation: published.operation, state: "running" });
      }
    }

    const marker = "must-not-appear-in-errors";
    let failure: unknown;
    try {
      await publishTrustedConfigurationSnapshot({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [{ serviceId: "redis", values: { TOKEN: marker } }],
        },
        now: () => Date.parse("2026-08-24T08:00:00.000Z"),
        nonce: () => "nonce_0000000000000128",
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("Trusted configuration snapshot publish failed");
    expect((failure as Error).message).not.toContain(marker);
    expect(readdirSync(claimed)).toHaveLength(4);
    expect(readdirSync(root).filter((name) => name.endsWith(".json"))).toHaveLength(124);
    await expect(
      initializeTrustedSnapshotDirectory(root, {
        allowedUids: [statSync(root).uid],
        expectedGid: statSync(root).gid,
        token,
        nowMs: Date.parse("2026-08-24T08:00:00.000Z"),
        journalRecords,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("shares the exact active-claimed-plus-ready byte boundary with restart", async () => {
    const root = directory();
    const claimed = join(root, ".claimed");
    mkdirSync(claimed, { mode: 0o700 });
    const journalRecords: Array<{
      operation: Awaited<ReturnType<typeof make>>["operation"];
      state: "running";
    }> = [];
    const secretValues = Object.fromEntries(
      Array.from({ length: 7 }, (_, index) => [`SECRET_${index}`, "x".repeat(60_000)]),
    );
    async function make(index: number) {
      return publishTrustedConfigurationSnapshot({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: ["redis"],
          serviceConfigs: [{ serviceId: "redis", values: {} }],
          integrationConfigs: [],
          serviceSecrets: [{ serviceId: "redis", values: secretValues }],
        },
        now: () => Date.parse("2026-08-24T08:00:00.000Z"),
        nonce: () => `nonce_${index.toString().padStart(16, "0")}`,
      });
    }
    let next = 0;
    let snapshotBytes = 0;
    while (next < 64) {
      try {
        const published = await make(next);
        snapshotBytes = published.bytes.byteLength;
        if (next < 4) {
          renameSync(
            join(root, `${published.revisionId}.json`),
            join(claimed, `${published.revisionId}.json`),
          );
          journalRecords.push({ operation: published.operation, state: "running" });
        }
        next += 1;
      } catch (error) {
        expect((error as Error).message).toBe("Trusted configuration snapshot publish failed");
        break;
      }
    }
    expect(next).toBeGreaterThan(4);
    expect(next).toBeLessThan(64);
    const retainedBytes = [
      ...readdirSync(root)
        .filter((name) => name.endsWith(".json"))
        .map((name) => statSync(join(root, name)).size),
      ...readdirSync(claimed).map((name) => statSync(join(claimed, name)).size),
    ].reduce((sum, size) => sum + size, 0);
    expect(retainedBytes).toBeLessThanOrEqual(OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES);
    expect(retainedBytes + snapshotBytes).toBeGreaterThan(OPS_TRUSTED_CONFIG_QUEUE_MAX_BYTES);
    await expect(
      initializeTrustedSnapshotDirectory(root, {
        allowedUids: [statSync(root).uid],
        expectedGid: statSync(root).gid,
        token,
        nowMs: Date.parse("2026-08-24T08:00:00.000Z"),
        journalRecords,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("removes an exact unpublished candidate after transport failure and permits an exact retry", async () => {
    const root = directory();
    const make = () =>
      publishTrustedConfigurationSnapshot({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        now: () => Date.parse("2026-08-24T08:00:00.000Z"),
        nonce: () => "nonce_0123456789abcdef",
      });
    const first = await make();
    await expect(
      consumePublishedTrustedConfiguration(first, async () => {
        throw new Error("transport unavailable");
      }),
    ).rejects.toThrow("transport unavailable");
    expect(readdirSync(root)).toEqual([]);

    const retry = await make();
    await expect(
      consumePublishedTrustedConfiguration(retry, async () => ({ revisionId: retry.revisionId })),
    ).resolves.toEqual({ revisionId: retry.revisionId });
    expect(readdirSync(root)).toEqual([]);
  });

  it("does not accumulate ready snapshots across 129 simulated network failures", async () => {
    const root = directory();
    for (let index = 0; index < 129; index += 1) {
      const published = await publishTrustedConfigurationSnapshot({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        now: () => Date.parse("2026-08-24T08:00:00.000Z"),
        nonce: () => `nonce_${index.toString().padStart(16, "0")}`,
      });
      await expect(
        consumePublishedTrustedConfiguration(published, async () => {
          throw new Error("agent unavailable");
        }),
      ).rejects.toThrow("agent unavailable");
    }
    expect(readdirSync(root)).toEqual([]);
  }, 60_000);

  it("preserves a replacement raced into the candidate path instead of deleting it", async () => {
    const root = directory();
    const preserved = join(root, "preserved-candidate");
    const replacement = "unrelated replacement";
    let finalPath = "";
    const published = await publishTrustedConfigurationSnapshot(
      {
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        nonce: () => "nonce_0123456789abcdef",
      },
      {
        beforeAbortRename: async () => {
          renameSync(finalPath, preserved);
          writeFileSync(finalPath, replacement, { mode: 0o600 });
        },
      },
    );
    finalPath = join(root, `${published.revisionId}.json`);
    await expect(published.abort()).rejects.toThrow(
      "Trusted configuration snapshot publish failed",
    );
    expect(readFileSync(finalPath, "utf8")).toBe(replacement);
    expect(readFileSync(preserved)).toEqual(published.bytes);
    expect(readdirSync(root).some((name) => name.endsWith(".abort"))).toBe(false);
  });

  it("never overwrites or unlinks a pre-existing abort destination", async () => {
    const root = directory();
    const published = await publishTrustedConfigurationSnapshot({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
      payload: {
        domain: "maps.example.test",
        selectedRoots: [],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      nonce: () => "nonce_0123456789abcdef",
    });
    const finalPath = join(root, `${published.revisionId}.json`);
    const abortPath = join(root, `.${published.revisionId}.nonce_0123456789abcdef.abort`);
    const different = Buffer.from("pre-existing different abort inode\n");
    writeFileSync(abortPath, different, { mode: 0o600 });

    await expect(published.abort()).rejects.toThrow(
      "Trusted configuration snapshot publish failed",
    );
    expect(readFileSync(abortPath)).toEqual(different);
    expect(readFileSync(finalPath)).toEqual(published.bytes);
  });

  it.each([
    "afterAbortLink",
    "afterAbortLinkSync",
    "afterAbortSourceUnlink",
    "afterAbortSourceSync",
    "afterAbortTombstoneUnlink",
    "afterAbortTombstoneSync",
  ] as const)("resumes an exact abort after a crash at %s", async (transition) => {
    const root = directory();
    let crash = true;
    const published = await publishTrustedConfigurationSnapshot(
      {
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        nonce: () => "nonce_0123456789abcdef",
      },
      {
        [transition]: async () => {
          if (!crash) return;
          crash = false;
          throw new Error("simulated abort crash");
        },
      },
    );

    await expect(published.abort()).rejects.toThrow(
      "Trusted configuration snapshot publish failed",
    );
    await expect(published.abort()).resolves.toBeUndefined();
    expect(readdirSync(root)).toEqual([]);
  });

  it("shares one no-clobber state machine across concurrent abort calls", async () => {
    const root = directory();
    const published = await publishTrustedConfigurationSnapshot({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      operationKey: "opk1_0123456789abcdef",
      operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
      payload: {
        domain: "maps.example.test",
        selectedRoots: [],
        serviceConfigs: [],
        integrationConfigs: [],
        serviceSecrets: [],
      },
      nonce: () => "nonce_0123456789abcdef",
    });
    await expect(Promise.all([published.abort(), published.abort()])).resolves.toEqual([
      undefined,
      undefined,
    ]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("preserves a different abort inode raced in after the no-clobber link", async () => {
    const root = directory();
    let abortPath = "";
    const preserved = join(root, "preserved-authenticated-abort");
    const different = Buffer.from("different raced abort inode\n");
    const published = await publishTrustedConfigurationSnapshot(
      {
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        operationKey: "opk1_0123456789abcdef",
        operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
        payload: {
          domain: "maps.example.test",
          selectedRoots: [],
          serviceConfigs: [],
          integrationConfigs: [],
          serviceSecrets: [],
        },
        nonce: () => "nonce_0123456789abcdef",
      },
      {
        afterAbortLink: async () => {
          renameSync(abortPath, preserved);
          writeFileSync(abortPath, different, { mode: 0o600 });
        },
      },
    );
    abortPath = join(root, `.${published.revisionId}.nonce_0123456789abcdef.abort`);

    await expect(published.abort()).rejects.toThrow(
      "Trusted configuration snapshot publish failed",
    );
    expect(readFileSync(abortPath)).toEqual(different);
    expect(readFileSync(preserved)).toEqual(published.bytes);
    expect(readFileSync(join(root, `${published.revisionId}.json`))).toEqual(published.bytes);
  });
});
