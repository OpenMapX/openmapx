import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireTrustedConfigurationQueueLock,
  OPS_TRUSTED_CONFIG_MAX_BYTES,
  sealTrustedConfigurationSnapshot,
  type TrustedConfigurationPayload,
} from "@openmapx/core/ops";
import { afterEach, describe, expect, it } from "vitest";
import {
  createFileTrustedOpsDataSource,
  initializeTrustedSnapshotDirectory,
} from "./trusted-config-source";

const roots: string[] = [];
const token = Buffer.alloc(32, 0x37).toString("base64url");
const now = Date.parse("2026-08-24T08:00:00.000Z");

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "openmapx-trusted-source-"));
  roots.push(value);
  chmodSync(value, 0o700);
  mkdirSync(join(value, ".claimed"), { mode: 0o700 });
  return value;
}

function payload(): TrustedConfigurationPayload {
  return {
    domain: "maps.example.test",
    selectedRoots: ["redis"],
    serviceConfigs: [{ serviceId: "redis", values: {} }],
    integrationConfigs: [],
    serviceSecrets: [],
  };
}

function sealed(issuedAtMs = now) {
  return sealTrustedConfigurationSnapshot({
    role: "api",
    operationKey: "opk1_0123456789abcdef",
    operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
    payload: payload(),
    token,
    issuedAtMs,
    nonce: "nonce_0123456789abcdef",
  });
}

function distinctSealed(index: number) {
  return sealTrustedConfigurationSnapshot({
    role: "api",
    operationKey: "opk1_0123456789abcdef",
    operationForRevision: (revisionId) => ({ kind: "stack.render", revisionId }),
    payload: payload(),
    token,
    issuedAtMs: now,
    nonce: `nonce_${index.toString().padStart(16, "0")}`,
  });
}

function writeReady(directory: string, snapshot = sealed()): string {
  const path = join(directory, `${snapshot.revisionId}.json`);
  writeFileSync(path, snapshot.bytes, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

function source(directory: string) {
  return createFileTrustedOpsDataSource({
    directory,
    token,
    allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
    expectedGid: statSync(directory).gid,
    now: () => now + 1,
  });
}

describe("file-backed trusted configuration source", () => {
  it("bounds the queue and rejects unknown entries before cleaning safe temporaries", async () => {
    const directory = root();
    const temporary = join(
      directory,
      ".cfg1_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG.nonce_0123456789abcdef.tmp",
    );
    writeFileSync(temporary, "partial", { mode: 0o600 });
    const unknown = join(directory, "unexpected");
    writeFileSync(unknown, "do-not-touch", { mode: 0o600 });

    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(directory).gid,
        token,
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
    expect(readFileSync(temporary, "utf8")).toBe("partial");
    expect(readFileSync(unknown, "utf8")).toBe("do-not-touch");
  });

  it("cleans only an exact safe crash temporary and syncs to an empty ready queue", async () => {
    const directory = root();
    const temporary = join(
      directory,
      ".cfg1_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG.nonce_0123456789abcdef.tmp",
    );
    writeFileSync(temporary, "partial", { mode: 0o600 });

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
    });

    expect(readdirSync(directory)).toEqual([".claimed"]);
  });

  it("rejects queue entry-count and retained-byte exhaustion before mutation", async () => {
    const countDirectory = root();
    for (let index = 0; index < 129; index += 1) {
      writeFileSync(join(countDirectory, `cfg1_${index.toString().padStart(43, "0")}.json`), "{}", {
        mode: 0o600,
      });
    }
    await expect(
      initializeTrustedSnapshotDirectory(countDirectory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(countDirectory).gid,
        token,
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
    expect(readdirSync(countDirectory)).toHaveLength(130);

    const byteDirectory = root();
    for (let index = 0; index < 33; index += 1) {
      const file = join(byteDirectory, `cfg1_${index.toString().padStart(43, "A")}.json`);
      writeFileSync(file, "", { mode: 0o600 });
      truncateSync(file, OPS_TRUSTED_CONFIG_MAX_BYTES);
    }
    await expect(
      initializeTrustedSnapshotDirectory(byteDirectory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(byteDirectory).gid,
        token,
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
    expect(readdirSync(byteDirectory)).toHaveLength(34);
  });

  it("refuses admission without mutation when authenticated retained state exceeds restart bounds", async () => {
    const directory = root();
    const snapshots = Array.from({ length: 129 }, (_, index) => distinctSealed(index));
    for (const snapshot of snapshots) writeReady(directory, snapshot);
    const target = join(directory, `${snapshots[0].revisionId}.json`);
    await expect(
      source(directory).claim(
        snapshots[0].operation,
        snapshots[0].operationFingerprint,
        new AbortController().signal,
        { role: "api", operationKey: "opk1_0123456789abcdef" },
      ),
    ).resolves.toBeNull();
    expect(readFileSync(target)).toEqual(snapshots[0].bytes);
    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
  });

  it("does not age-delete a nonterminal claimed recovery snapshot", async () => {
    const directory = root();
    const snapshot = sealed(now - 48 * 60 * 60_000);
    const ready = writeReady(directory, snapshot);
    const claimed = join(directory, ".claimed", `${snapshot.revisionId}.json`);
    renameSync(ready, claimed);
    const old = new Date(now - 48 * 60 * 60_000);
    utimesSync(claimed, old, old);

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      nowMs: now,
      journalRecords: [{ operation: snapshot.operation, state: "running" }],
    });

    expect(() => statSync(claimed)).not.toThrow();
  });

  it("removes a pre-admission claimed orphan with no durable journal owner", async () => {
    const directory = root();
    const snapshot = sealed();
    const ready = writeReady(directory, snapshot);
    const claimed = join(directory, ".claimed", `${snapshot.revisionId}.json`);
    renameSync(ready, claimed);

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      nowMs: now,
    });

    expect(() => statSync(claimed)).toThrow();
  });

  it("authenticates and removes expired ready snapshots by signed expiry before retained bounds", async () => {
    const directory = root();
    for (let index = 0; index < 129; index += 1) {
      writeReady(directory, distinctSealed(index));
    }

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      nowMs: now + 5 * 60_000 + 1,
    });

    expect(readdirSync(directory)).toEqual([".claimed"]);
  });

  it("recovers an authenticated publisher abort temporary after restart", async () => {
    const directory = root();
    const snapshot = sealed();
    const aborted = join(directory, `.${snapshot.revisionId}.nonce_0123456789abcdef.abort`);
    writeFileSync(aborted, snapshot.bytes, { mode: 0o600 });

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      nowMs: now + 1,
    });

    expect(readdirSync(directory)).toEqual([".claimed"]);
  });

  it("reconciles the exact two-link publisher abort crash pair on restart", async () => {
    const directory = root();
    const snapshot = sealed();
    const ready = writeReady(directory, snapshot);
    const aborted = join(directory, `.${snapshot.revisionId}.nonce_0123456789abcdef.abort`);
    linkSync(ready, aborted);

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      nowMs: now + 1,
    });

    expect(readdirSync(directory)).toEqual([".claimed"]);
  });

  it("does not delete an abort temporary whose authenticated revision mismatches its name", async () => {
    const directory = root();
    const snapshot = sealed();
    const mismatched = join(directory, `.cfg1_${"m".repeat(43)}.nonce_0123456789abcdef.abort`);
    writeFileSync(mismatched, snapshot.bytes, { mode: 0o600 });

    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(directory).gid,
        token,
        nowMs: now + 1,
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
    expect(() => statSync(mismatched)).not.toThrow();
  });

  it.each(["symlink", "hardlink", "directory"] as const)(
    "rejects an unsafe %s queue temporary without deleting it",
    async (kind) => {
      const directory = root();
      const temporary = join(
        directory,
        ".cfg1_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG.nonce_0123456789abcdef.tmp",
      );
      const target = join(directory, "target");
      if (kind === "directory") mkdirSync(temporary, { mode: 0o700 });
      else {
        writeFileSync(target, "partial", { mode: 0o600 });
        if (kind === "symlink") symlinkSync(target, temporary);
        else linkSync(target, temporary);
      }
      await expect(
        initializeTrustedSnapshotDirectory(directory, {
          allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
          expectedGid: statSync(directory).gid,
          token,
        }),
      ).rejects.toThrow("Trusted configuration snapshot directory rejected");
      expect(() => statSync(temporary)).not.toThrow();
    },
  );

  it("preserves a hardlink replacement raced into a validated single cleanup path", async () => {
    const directory = root();
    const temporary = join(
      directory,
      ".cfg1_0123456789abcdefghijklmnopqrstuvwxyzABCDEFG.nonce_0123456789abcdef.tmp",
    );
    const preserved = join(directory, "preserved-crash-temporary");
    const replacementSource = join(directory, "replacement-source");
    writeFileSync(temporary, "partial", { mode: 0o600 });

    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(directory).gid,
        token,
        beforeCleanupUnlink: (path) => {
          renameSync(path, preserved);
          writeFileSync(replacementSource, "different inode", { mode: 0o600 });
          linkSync(replacementSource, path);
        },
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");

    expect(readFileSync(temporary, "utf8")).toBe("different inode");
    expect(readFileSync(preserved, "utf8")).toBe("partial");
    expect(statSync(temporary).ino).toBe(statSync(replacementSource).ino);
  });

  it("claims one exact validated snapshot and rejects replay under a second admission", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const trusted = source(directory);
    const resolution = await trusted.claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    expect(resolution).toMatchObject({
      capability: {
        revisionId: snapshot.revisionId,
        values: {},
        trustedConfiguration: payload(),
      },
    });
    expect(() => readFileSync(join(directory, `${snapshot.revisionId}.json`))).toThrow();
    expect(() =>
      readFileSync(join(directory, ".claimed", `${snapshot.revisionId}.json`)),
    ).not.toThrow();
    await resolution?.admission.commit();
    await expect(
      trusted.claim(
        snapshot.operation,
        snapshot.operationFingerprint,
        new AbortController().signal,
        { role: "api", operationKey: "opk1_fedcba9876543210" },
      ),
    ).resolves.toBeNull();
    expect(
      readFileSync(join(directory, ".claimed", `${snapshot.revisionId}.json`), "utf8"),
    ).toContain("serviceSecrets");
  });

  it("durably removes a claimed snapshot when its journaled job becomes terminal", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const resolution = await source(directory).claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    await resolution?.admission.commit();
    expect(readdirSync(join(directory, ".claimed"))).toEqual([`${snapshot.revisionId}.json`]);

    await resolution?.admission.release();

    expect(readdirSync(directory).sort()).toEqual([".claimed"]);
    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
  });

  it("recovers the exact hardlink terminal tombstone after a crash before source unlink", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const resolution = await createFileTrustedOpsDataSource({
      directory,
      token,
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      now: () => now + 1,
      afterTerminalLink: async () => {
        throw new Error("simulated crash after terminal link");
      },
    }).claim(snapshot.operation, snapshot.operationFingerprint, new AbortController().signal, {
      role: "api",
      operationKey: "opk1_0123456789abcdef",
    });
    await resolution?.admission.commit();
    await expect(resolution?.admission.release()).rejects.toThrow(
      "Trusted configuration release failed",
    );
    const claimedPath = join(directory, ".claimed", `${snapshot.revisionId}.json`);
    const tombstone = join(directory, `.${snapshot.revisionId}.terminal.abort`);
    expect(statSync(claimedPath).ino).toBe(statSync(tombstone).ino);
    expect(statSync(claimedPath).nlink).toBe(2);

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      journalRecords: [
        {
          operation: snapshot.operation,
          state: "succeeded",
          terminalAt: new Date(now).toISOString(),
        },
      ],
    });

    expect(readdirSync(directory)).toEqual([".claimed"]);
    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
  });

  it("recovers the exact terminal tombstone after a crash following source unlink", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const resolution = await createFileTrustedOpsDataSource({
      directory,
      token,
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      now: () => now + 1,
      afterTerminalSourceUnlink: async () => {
        throw new Error("simulated crash after source unlink");
      },
    }).claim(snapshot.operation, snapshot.operationFingerprint, new AbortController().signal, {
      role: "api",
      operationKey: "opk1_0123456789abcdef",
    });
    await resolution?.admission.commit();
    await expect(resolution?.admission.release()).rejects.toThrow(
      "Trusted configuration release failed",
    );
    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
    expect(readdirSync(directory)).toContain(`.${snapshot.revisionId}.terminal.abort`);

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      journalRecords: [
        { operation: snapshot.operation, state: "failed", terminalAt: new Date(now).toISOString() },
      ],
    });
    expect(readdirSync(directory)).toEqual([".claimed"]);
  });

  it("never reconciles a terminal tombstone with a different inode", async () => {
    const directory = root();
    const snapshot = sealed();
    const claimedPath = join(directory, ".claimed", `${snapshot.revisionId}.json`);
    const tombstone = join(directory, `.${snapshot.revisionId}.terminal.abort`);
    writeFileSync(claimedPath, snapshot.bytes, { mode: 0o600 });
    writeFileSync(tombstone, snapshot.bytes, { mode: 0o600 });

    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(directory).gid,
        token,
        journalRecords: [
          {
            operation: snapshot.operation,
            state: "succeeded",
            terminalAt: new Date(now).toISOString(),
          },
        ],
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
    expect(statSync(claimedPath).ino).not.toBe(statSync(tombstone).ino);
  });

  it.each(["tombstone", "source"] as const)(
    "preserves a different inode raced into the validated terminal %s cleanup path",
    async (boundary) => {
      const directory = root();
      const snapshot = sealed();
      const claimedPath = join(directory, ".claimed", `${snapshot.revisionId}.json`);
      const tombstonePath = join(directory, `.${snapshot.revisionId}.terminal.abort`);
      const target = boundary === "tombstone" ? tombstonePath : claimedPath;
      const preserved = join(directory, `preserved-${boundary}`);
      writeFileSync(claimedPath, snapshot.bytes, { mode: 0o600 });
      linkSync(claimedPath, tombstonePath);
      let cleanupIndex = 0;

      await expect(
        initializeTrustedSnapshotDirectory(directory, {
          allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
          expectedGid: statSync(directory).gid,
          token,
          journalRecords: [
            {
              operation: snapshot.operation,
              state: "succeeded",
              terminalAt: new Date(now).toISOString(),
            },
          ],
          beforeCleanupUnlink: (path: string) => {
            if (cleanupIndex === (boundary === "tombstone" ? 0 : 1)) {
              renameSync(path, preserved);
              if (boundary === "tombstone") {
                writeFileSync(path, "different inode", { mode: 0o600 });
              } else {
                symlinkSync(preserved, path);
              }
            }
            cleanupIndex += 1;
          },
        }),
      ).rejects.toThrow("Trusted configuration snapshot directory rejected");

      expect(lstatSync(target).isFile()).toBe(boundary === "tombstone");
      expect(() => lstatSync(preserved)).not.toThrow();
      expect(readFileSync(preserved)).toEqual(snapshot.bytes);
    },
  );

  it("terminal release does not depend on reclaiming a contended retained-budget lease", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const resolution = await source(directory).claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    await resolution?.admission.commit();
    const competing = await acquireTrustedConfigurationQueueLock({
      directory,
      token,
      ownerUid: statSync(directory).uid,
      ownerGid: statSync(directory).gid,
      participant: "api",
      operationKey: "opk1_fedcba9876543210",
    });
    try {
      await expect(resolution?.admission.release()).resolves.toBeUndefined();
    } finally {
      competing.release();
    }
    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
  }, 1_000);

  it("survives restart after more than 128 terminal applies without retaining secret snapshots", async () => {
    const directory = root();
    for (let index = 0; index < 130; index += 1) {
      const snapshot = distinctSealed(index);
      writeReady(directory, snapshot);
      const resolution = await source(directory).claim(
        snapshot.operation,
        snapshot.operationFingerprint,
        new AbortController().signal,
        { role: "api", operationKey: "opk1_0123456789abcdef" },
      );
      expect(resolution?.capability.revisionId).toBe(snapshot.revisionId);
      await resolution?.admission.commit();
      await resolution?.admission.release();
    }

    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(directory).gid,
        token,
      }),
    ).resolves.toBeUndefined();
  }, 60_000);

  it("validates all entries before cleaning 129 journal-terminal recovery claims", async () => {
    const directory = root();
    const journalRecords: Array<{
      operation: ReturnType<typeof distinctSealed>["operation"];
      state: "succeeded";
      terminalAt: string;
    }> = [];
    for (let index = 0; index < 129; index += 1) {
      const snapshot = distinctSealed(index);
      const claimed = join(directory, ".claimed", `${snapshot.revisionId}.json`);
      writeFileSync(claimed, snapshot.bytes, { mode: 0o600 });
      journalRecords.push({
        operation: snapshot.operation,
        state: "succeeded",
        terminalAt: new Date(now).toISOString(),
      });
    }

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      journalRecords,
    });

    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
  }, 60_000);

  it("cleans 129 pre-admission claimed crash orphans before retained restart bounds", async () => {
    const directory = root();
    for (let index = 0; index < 129; index += 1) {
      const snapshot = distinctSealed(index);
      writeFileSync(join(directory, ".claimed", `${snapshot.revisionId}.json`), snapshot.bytes, {
        mode: 0o600,
      });
    }

    await initializeTrustedSnapshotDirectory(directory, {
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      token,
      nowMs: now + 1,
    });

    expect(readdirSync(join(directory, ".claimed"))).toEqual([]);
  });

  it("rolls back a pre-admission claim by removing it and permits an exact republish retry", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const first = await source(directory).claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    await first?.admission.rollback();
    expect(() => statSync(join(directory, `${snapshot.revisionId}.json`))).toThrow();
    writeReady(directory, snapshot);
    const retry = await source(directory).claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    expect(retry?.capability.revisionId).toBe(snapshot.revisionId);
    await retry?.admission.commit();
  });

  it("does not let a timed-out same-key claim erase a concurrent admission", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const trusted = source(directory);
    const first = await trusted.claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    const second = await trusted.claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    await first?.admission.rollback();
    expect(() =>
      statSync(join(directory, ".claimed", `${snapshot.revisionId}.json`)),
    ).not.toThrow();
    await second?.admission.commit();
    expect(() =>
      statSync(join(directory, ".claimed", `${snapshot.revisionId}.json`)),
    ).not.toThrow();
  });

  it("recovers an exact-key retry after a crash immediately after claim rename", async () => {
    const directory = root();
    const snapshot = sealed();
    writeReady(directory, snapshot);
    const crashing = createFileTrustedOpsDataSource({
      directory,
      token,
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      now: () => now + 1,
      afterClaimRename: async () => {
        throw new Error("simulated crash");
      },
    });
    const first = await crashing.claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    expect(first).toBeNull();
    const retry = await source(directory).claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    expect(retry?.capability.trustedConfiguration).toEqual(payload());
    await retry?.admission.commit();
  });

  it.each(["symlink", "hardlink", "writable", "oversized", "stale", "malformed"] as const)(
    "rejects an unsafe %s snapshot without consuming or mutating output",
    async (kind) => {
      const directory = root();
      const snapshot = kind === "stale" ? sealed(now - 10 * 60_000) : sealed();
      const ready = join(directory, `${snapshot.revisionId}.json`);
      const target = join(directory, "target");
      if (kind === "symlink") {
        writeFileSync(target, snapshot.bytes, { mode: 0o600 });
        symlinkSync(target, ready);
      } else if (kind === "hardlink") {
        writeFileSync(target, snapshot.bytes, { mode: 0o600 });
        linkSync(target, ready);
      } else if (kind === "oversized") {
        writeFileSync(ready, Buffer.alloc(OPS_TRUSTED_CONFIG_MAX_BYTES + 1), { mode: 0o600 });
      } else if (kind === "malformed") {
        writeFileSync(ready, Buffer.from([0x7b, 0x22, 0xff, 0x22, 0x7d]), { mode: 0o600 });
      } else {
        writeReady(directory, snapshot);
        if (kind === "writable") chmodSync(ready, 0o620);
      }
      const sentinel = join(directory, "output-sentinel");
      writeFileSync(sentinel, "unchanged", { mode: 0o600 });
      await expect(
        source(directory).claim(
          snapshot.operation,
          snapshot.operationFingerprint,
          new AbortController().signal,
          { role: "api", operationKey: "opk1_0123456789abcdef" },
        ),
      ).resolves.toBeNull();
      expect(readFileSync(sentinel, "utf8")).toBe("unchanged");
      expect(() => readFileSync(ready)).not.toThrow();
    },
  );

  it("rejects an unsafe queue directory before reading any snapshot", async () => {
    const directory = root();
    chmodSync(directory, 0o777);
    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: process.getegid?.() ?? process.getgid?.() ?? 0,
        token,
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
  });

  it("does not follow or chmod a hostile claimed-directory symlink", async () => {
    const directory = root();
    rmSync(join(directory, ".claimed"), { recursive: true });
    const target = join(directory, "outside");
    mkdirSync(target, { mode: 0o755 });
    symlinkSync(target, join(directory, ".claimed"));
    await expect(
      initializeTrustedSnapshotDirectory(directory, {
        allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
        expectedGid: statSync(directory).gid,
        token,
      }),
    ).rejects.toThrow("Trusted configuration snapshot directory rejected");
    expect(statSync(target).mode & 0o777).toBe(0o755);
  });

  it("rejects an inode swap immediately before claim rename without consuming the replacement", async () => {
    const directory = root();
    const snapshot = sealed();
    const ready = writeReady(directory, snapshot);
    const original = `${ready}.original`;
    const swapping = createFileTrustedOpsDataSource({
      directory,
      token,
      allowedUids: [process.geteuid?.() ?? process.getuid?.() ?? 0],
      expectedGid: statSync(directory).gid,
      now: () => now + 1,
      beforeClaimRename: async () => {
        renameSync(ready, original);
        writeFileSync(ready, snapshot.bytes, { mode: 0o600 });
      },
    });
    const resolution = await swapping.claim(
      snapshot.operation,
      snapshot.operationFingerprint,
      new AbortController().signal,
      { role: "api", operationKey: "opk1_0123456789abcdef" },
    );
    expect(resolution).toBeNull();
    expect(readFileSync(ready)).toEqual(snapshot.bytes);
    expect(() => statSync(join(directory, ".claimed", `${snapshot.revisionId}.json`))).toThrow();
  });
});
