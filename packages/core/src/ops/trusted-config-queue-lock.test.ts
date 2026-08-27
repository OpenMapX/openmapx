import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  chmodSync,
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
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
  acquireTrustedConfigurationQueueLock,
  OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME,
} from "./trusted-config-queue-lock";

const roots: string[] = [];
const children: ChildProcess[] = [];
const token = Buffer.alloc(32, 0x6a).toString("base64url");

afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function liveHolder(root: string, ttlMs = 100): Promise<ChildProcess> {
  const moduleUrl = pathToFileURL(join(import.meta.dirname, "trusted-config-queue-lock.ts")).href;
  const code = `
    import { acquireTrustedConfigurationQueueLock } from ${JSON.stringify(moduleUrl)};
    const lock = await acquireTrustedConfigurationQueueLock({
      directory: process.env.QUEUE_ROOT,
      token: process.env.QUEUE_TOKEN,
      ownerUid: Number(process.env.QUEUE_UID),
      ownerGid: Number(process.env.QUEUE_GID),
      participant: "api",
      operationKey: "opk1_0123456789abcdef",
      ttlMs: ${ttlMs},
      acquireTimeoutMs: 500,
    });
    process.stdout.write("ready\\n");
    setInterval(() => lock.assertHeld(), 25);
  `;
  const child = spawn(
    process.execPath,
    ["--experimental-strip-types", "--input-type=module", "-e", code],
    {
      env: {
        ...process.env,
        QUEUE_ROOT: root,
        QUEUE_TOKEN: token,
        QUEUE_UID: String(statSync(root).uid),
        QUEUE_GID: String(statSync(root).gid),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  if (!child.stdout) throw new Error("child stdout unavailable");
  const [chunk] = (await once(child.stdout, "data")) as [Buffer];
  expect(chunk.toString()).toContain("ready");
  return child;
}

function directory(): string {
  const root = mkdtempSync(join(tmpdir(), "openmapx-config-lock-"));
  roots.push(root);
  chmodSync(root, 0o700);
  return root;
}

const publicationTransitions = [
  "afterPublicationIntentWrite",
  "afterOwnerRecordWrite",
  "afterInitialHeartbeatRecordWrite",
  "afterStableLockDirectorySync",
  "afterPublicationCommit",
] as const;

describe("trusted configuration retained-budget lock", () => {
  it("exposes the exact stable-directory crash boundary before publication is authenticated", async () => {
    const root = directory();
    let namesAtBoundary: string[] = [];
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        acquireTimeoutMs: 0,
        afterStableLockDirectoryCreate: () => {
          namesAtBoundary = readdirSync(root).sort();
          throw new Error("simulated crash before authenticated publication");
        },
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    expect(namesAtBoundary).toEqual([OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME]);
    expect(readdirSync(root)).toEqual([OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME]);
  });

  it("preserves an unbound stable crash inode and gives deterministic operator guidance", async () => {
    const root = directory();
    const lockPath = join(root, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        acquireTimeoutMs: 0,
        afterStableLockDirectoryCreate: () => {
          throw new Error("simulated crash before authenticated publication");
        },
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    const residue = statSync(lockPath);

    for (const attempt of [
      { participant: "api" as const, operationKey: "opk1_0123456789abcdef" },
      { participant: "ops-agent" as const, operationKey: "startup" },
    ]) {
      await expect(
        acquireTrustedConfigurationQueueLock({
          directory: root,
          token,
          ownerUid: statSync(root).uid,
          ownerGid: statSync(root).gid,
          ...attempt,
          acquireTimeoutMs: 0,
        }),
      ).rejects.toThrow("Trusted configuration queue artifacts require operator cleanup");
      expect(statSync(lockPath).dev).toBe(residue.dev);
      expect(statSync(lockPath).ino).toBe(residue.ino);
      expect(readdirSync(lockPath)).toEqual([]);
    }
  });

  it.each(publicationTransitions)(
    "recovers an exact failed publication after %s",
    async (transition) => {
      const root = directory();
      const crashing = {
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api" as const,
        operationKey: "opk1_0123456789abcdef",
        ttlMs: 50,
        acquireTimeoutMs: 0,
        [transition]: () => {
          throw new Error("simulated publication crash");
        },
      };
      await expect(acquireTrustedConfigurationQueueLock(crashing)).rejects.toThrow(
        "Trusted configuration queue busy",
      );
      expect(readdirSync(root).length).toBeGreaterThan(0);
      await delay(75);
      const recovered = await acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        ttlMs: 50,
        acquireTimeoutMs: 500,
      });
      recovered.release();
      expect(readdirSync(root)).toEqual([]);
    },
  );

  it("cleans only its exact losing temporary after a publish-name collision", async () => {
    const root = directory();
    const lockPath = join(root, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        acquireTimeoutMs: 0,
        beforeLockDirectoryCreate: () => mkdirSync(lockPath, { mode: 0o700 }),
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    expect(readdirSync(root)).toEqual([OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME]);
    rmSync(lockPath, { recursive: true });
    const retry = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "api",
      operationKey: "opk1_0123456789abcdef",
      acquireTimeoutMs: 250,
    });
    retry.release();
  });

  it("gives bounded operator guidance for 17 unauthenticated artifacts without deleting them", async () => {
    const root = directory();
    for (let index = 0; index < 17; index += 1) {
      mkdirSync(
        join(
          root,
          `${OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME}.tmp.${index.toString(16).padStart(32, "0")}`,
        ),
        { mode: 0o700 },
      );
    }
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        acquireTimeoutMs: 0,
      }),
    ).rejects.toThrow("Trusted configuration queue artifacts require operator cleanup");
    expect(readdirSync(root)).toHaveLength(17);
  });

  it("counts every unrelated directory entry at the exact 256/257 scan boundary", async () => {
    const root = directory();
    const names = Array.from(
      { length: 257 },
      (_, index) => `unrelated-${index.toString().padStart(3, "0")}`,
    );
    for (const name of names.slice(0, 256)) {
      writeFileSync(join(root, name), "not inspected", { mode: 0o600 });
    }
    const bounded = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "api",
      operationKey: "opk1_0123456789abcdef",
      acquireTimeoutMs: 0,
    });
    bounded.release();
    expect(readdirSync(root).sort()).toEqual(names.slice(0, 256));

    writeFileSync(join(root, names[256]), "not inspected", { mode: 0o600 });
    for (const participant of ["api", "ops-agent"] as const) {
      await expect(
        acquireTrustedConfigurationQueueLock({
          directory: root,
          token,
          ownerUid: statSync(root).uid,
          ownerGid: statSync(root).gid,
          participant,
          operationKey: participant === "api" ? "opk1_0123456789abcdef" : "opk1_fedcba9876543210",
          acquireTimeoutMs: 0,
        }),
      ).rejects.toThrow("Trusted configuration queue artifacts require operator cleanup");
    }
    expect(readdirSync(root).sort()).toEqual(names);

    rmSync(join(root, names[256]));
    const afterGuidance = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "ops-agent",
      operationKey: "opk1_fedcba9876543210",
      acquireTimeoutMs: 0,
    });
    afterGuidance.release();
  });

  it("counts valid ready-style names without opening or deleting their contents", async () => {
    const root = directory();
    const names = Array.from(
      { length: 257 },
      (_, index) => `cfg1_${index.toString().padStart(43, "0")}.json`,
    );
    for (const name of names) writeFileSync(join(root, name), "not a snapshot", { mode: 0o600 });

    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        acquireTimeoutMs: 0,
      }),
    ).rejects.toThrow("Trusted configuration queue artifacts require operator cleanup");
    expect(readdirSync(root).sort()).toEqual(names);
    expect(readFileSync(join(root, names[0]), "utf8")).toBe("not a snapshot");
  });

  it("counts a mixed live authenticated publication without mutating it", async () => {
    const root = directory();
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        ttlMs: 30_000,
        acquireTimeoutMs: 0,
        afterPublicationIntentWrite: () => {
          throw new Error("simulated authenticated publication crash");
        },
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    const unrelated = Array.from(
      { length: 255 },
      (_, index) => `mixed-${index.toString().padStart(3, "0")}`,
    );
    for (const name of unrelated.slice(0, 254)) {
      writeFileSync(join(root, name), "not inspected", { mode: 0o600 });
    }
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        acquireTimeoutMs: 0,
      }),
    ).rejects.toThrow("Trusted configuration queue busy");

    writeFileSync(join(root, unrelated[254]), "not inspected", { mode: 0o600 });
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        acquireTimeoutMs: 0,
      }),
    ).rejects.toThrow("Trusted configuration queue artifacts require operator cleanup");
    expect(readdirSync(root)).toHaveLength(257);

    rmSync(join(root, unrelated[254]));
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        acquireTimeoutMs: 0,
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    expect(readdirSync(root)).toHaveLength(256);
  });

  it("does not reclaim a live multiprocess holder beyond its original expiry", async () => {
    const root = directory();
    const child = await liveHolder(root);
    await delay(250);
    expect(child.exitCode).toBeNull();
    let recovered: Awaited<ReturnType<typeof acquireTrustedConfigurationQueueLock>> | undefined;
    try {
      recovered = await acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        ttlMs: 100,
        acquireTimeoutMs: 100,
      });
    } catch {
      // Expected while the child heartbeat owns the generation.
    }
    await recovered?.release();
    expect(recovered).toBeUndefined();
    expect(child.exitCode).toBeNull();
  });

  it("recovers a crashed multiprocess holder without either participant restarting", async () => {
    const root = directory();
    const child = await liveHolder(root);
    child.kill("SIGKILL");
    await once(child, "exit");
    await delay(150);
    const recovered = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "ops-agent",
      operationKey: "opk1_fedcba9876543210",
      ttlMs: 100,
      acquireTimeoutMs: 1_000,
    });
    recovered.assertHeld();
    await recovered.release();
  });
  it("never deletes a live authenticated holder and releases only its exact inode", async () => {
    const root = directory();
    const options = {
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "api" as const,
      operationKey: "opk1_0123456789abcdef",
      ttlMs: 100,
      acquireTimeoutMs: 75,
    };
    const first = await acquireTrustedConfigurationQueueLock(options);
    await expect(acquireTrustedConfigurationQueueLock(options)).rejects.toThrow(
      "Trusted configuration queue busy",
    );
    first.assertHeld();
    first.release();
    const second = await acquireTrustedConfigurationQueueLock(options);
    second.release();
  });

  it("recovers an expired same-participant crash without process restart", async () => {
    const root = directory();
    const options = {
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "ops-agent" as const,
      operationKey: "opk1_0123456789abcdef",
      ttlMs: 500,
      acquireTimeoutMs: 0,
    };
    const crashed = await acquireTrustedConfigurationQueueLock(options);
    crashed.abandon();
    await expect(acquireTrustedConfigurationQueueLock(options)).rejects.toThrow(
      "Trusted configuration queue busy",
    );
    await delay(20);
    const recovered = await acquireTrustedConfigurationQueueLock({
      ...options,
      operationKey: "opk1_fedcba9876543210",
      acquireTimeoutMs: 750,
    });
    recovered.release();
  });

  it("does not treat a live reused PID as authority for an expired generation", async () => {
    const root = directory();
    const common = {
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      operationKey: "opk1_0123456789abcdef",
      ttlMs: 50,
      acquireTimeoutMs: 250,
    };
    const crashed = await acquireTrustedConfigurationQueueLock({ ...common, participant: "api" });
    crashed.abandon();
    await delay(75);
    const recovered = await acquireTrustedConfigurationQueueLock({
      ...common,
      participant: "ops-agent",
      operationKey: "opk1_fedcba9876543210",
    });
    recovered.release();
  });

  it("fails closed without deleting an unauthenticated stale lock", async () => {
    const root = directory();
    const lock = join(root, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    mkdirSync(lock, { mode: 0o700 });
    const owner = Buffer.from('{"expiresAtMs":0,"mac":"invalid"}\n');
    const heartbeat = Buffer.from('{"expiresAtMs":0,"mac":"invalid"}\n');
    writeFileSync(join(lock, "owner.json"), owner, { mode: 0o600 });
    writeFileSync(join(lock, "heartbeat.json"), heartbeat, { mode: 0o600 });
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    expect(readFileSync(join(lock, "owner.json"))).toEqual(owner);
    expect(readFileSync(join(lock, "heartbeat.json"))).toEqual(heartbeat);
  });

  it("detects a mid-critical-section inode swap and preserves the replacement", async () => {
    const root = directory();
    const lock = join(root, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    const held = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "api",
      operationKey: "opk1_0123456789abcdef",
    });
    renameSync(lock, join(root, "preserved-original"));
    mkdirSync(lock, { mode: 0o700 });
    const replacement = Buffer.from("untrusted replacement\n");
    writeFileSync(join(lock, "owner.json"), replacement, { mode: 0o600 });
    writeFileSync(join(lock, "heartbeat.json"), replacement, { mode: 0o600 });
    expect(() => held.assertHeld()).toThrow("Trusted configuration queue busy");
    expect(() => held.release()).toThrow("Trusted configuration queue busy");
    expect(readFileSync(join(lock, "owner.json"))).toEqual(replacement);
    held.abandon();
  });

  it("fails closed and stops the holder after heartbeat identity replacement", async () => {
    const root = directory();
    const lock = join(root, OPS_TRUSTED_CONFIG_QUEUE_LOCK_NAME);
    const held = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "ops-agent",
      operationKey: "opk1_0123456789abcdef",
      ttlMs: 1_000,
    });
    renameSync(join(lock, "heartbeat.json"), join(lock, "original-heartbeat.json"));
    const replacement = Buffer.from('{"mac":"invalid"}\n');
    writeFileSync(join(lock, "heartbeat.json"), replacement, { mode: 0o600 });
    expect(() => held.assertHeld()).toThrow("Trusted configuration queue busy");
    expect(() => held.release()).toThrow("Trusted configuration queue busy");
    await delay(400);
    expect(readFileSync(join(lock, "heartbeat.json"))).toEqual(replacement);
    held.abandon();
  });

  it("recovers a crashed heartbeat temporary only after its authenticated lease expires", async () => {
    const root = directory();
    const held = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "api",
      operationKey: "opk1_0123456789abcdef",
      ttlMs: 500,
      acquireTimeoutMs: 0,
      afterHeartbeatRecordWrite: () => {
        throw new Error("simulated heartbeat crash");
      },
    });
    expect(() => held.assertHeld()).toThrow("Trusted configuration queue busy");
    held.abandon();
    await expect(
      acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        ttlMs: 500,
        acquireTimeoutMs: 0,
      }),
    ).rejects.toThrow("Trusted configuration queue busy");
    await delay(550);
    const recovered = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "ops-agent",
      operationKey: "opk1_fedcba9876543210",
      ttlMs: 500,
      acquireTimeoutMs: 750,
    });
    recovered.release();
  });

  it("reconciles an authenticated quarantine crash after heartbeat unlink", async () => {
    const root = directory();
    const held = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "api",
      operationKey: "opk1_0123456789abcdef",
      ttlMs: 50,
      afterRecoveryHeartbeatUnlink: () => {
        throw new Error("simulated quarantine crash");
      },
    });
    expect(() => held.release()).toThrow("Trusted configuration queue busy");
    const recovered = await acquireTrustedConfigurationQueueLock({
      directory: root,
      token,
      ownerUid: statSync(root).uid,
      ownerGid: statSync(root).gid,
      participant: "ops-agent",
      operationKey: "opk1_fedcba9876543210",
      ttlMs: 50,
      acquireTimeoutMs: 250,
    });
    recovered.release();
  });

  it.each(["owner", "retirement"] as const)(
    "reconciles an authenticated quarantine crash after %s unlink",
    async (transition) => {
      const root = directory();
      const crash = (): never => {
        throw new Error("simulated quarantine crash");
      };
      const held = await acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "api",
        operationKey: "opk1_0123456789abcdef",
        ttlMs: 50,
        ...(transition === "owner"
          ? { afterRecoveryOwnerUnlink: crash }
          : { afterRecoveryRetirementUnlink: crash }),
      });
      expect(() => held.release()).toThrow("Trusted configuration queue busy");
      const recovered = await acquireTrustedConfigurationQueueLock({
        directory: root,
        token,
        ownerUid: statSync(root).uid,
        ownerGid: statSync(root).gid,
        participant: "ops-agent",
        operationKey: "opk1_fedcba9876543210",
        ttlMs: 50,
        acquireTimeoutMs: 250,
      });
      recovered.release();
    },
  );
});
