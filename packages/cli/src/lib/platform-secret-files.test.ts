import {
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertPlatformSecretMetadata,
  assertPlatformSecretParentOwner,
  ensurePlatformPrivateDirectory,
  ensurePlatformSecretFile,
  rotatePlatformSecretFile,
  writePlatformFileAtomically,
} from "./platform-secret-files";

const dirs: string[] = [];

function canonicalPassword(byte: number): string {
  return Buffer.alloc(32, byte).toString("base64url");
}

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "openmapx-platform-secret-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("ensurePlatformPrivateDirectory", () => {
  it("pre-creates a private host queue owned by the invoking uid/gid", () => {
    const directory = join(tempDir(), "data", "ops-agent", "trusted-config");

    const metadata = ensurePlatformPrivateDirectory(directory);

    const stats = lstatSync(directory);
    expect(stats.isDirectory()).toBe(true);
    expect(stats.mode & 0o777).toBe(0o700);
    expect(stats.uid).toBe(process.geteuid?.());
    expect(stats.gid).toBe(process.getegid?.());
    expect(metadata).toEqual({ uid: stats.uid, gid: stats.gid, mode: 0o700 });
  });

  it("rejects a symlink queue without changing its target", () => {
    const root = tempDir();
    const outside = join(root, "outside");
    const directory = join(root, "trusted-config");
    mkdirSync(outside, { mode: 0o755 });
    symlinkSync(outside, directory);

    expect(() => ensurePlatformPrivateDirectory(directory)).toThrow(/private directory is unsafe/);
    expect(lstatSync(outside).mode & 0o777).toBe(0o755);
  });
});

describe("ensurePlatformSecretFile", () => {
  it("creates a random secret once and reuses it on ordinary renders", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-password");
    const randomBytes = vi.fn(() => Buffer.alloc(32, 7));

    const first = ensurePlatformSecretFile(path, { randomBytes });
    const second = ensurePlatformSecretFile(path, {
      randomBytes: () => Buffer.alloc(32, 9),
    });

    expect(first).toBe(canonicalPassword(7));
    expect(second).toBe(first);
    expect(readFileSync(path, "utf8")).toBe(first);
    expect(randomBytes).toHaveBeenCalledTimes(1);
  });

  it("uses a 0700 host directory and a 0444 source file for non-root containers", () => {
    const path = join(tempDir(), "secrets", "redis-password");
    ensurePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 3) });

    expect(statSync(join(path, "..")).mode & 0o777).toBe(0o700);
    expect(statSync(path).mode & 0o777).toBe(0o444);
  });

  it("rejects symlink, non-regular, and empty existing targets", () => {
    const root = tempDir();
    const secretDir = join(root, "secrets");
    mkdirSync(secretDir);
    const real = join(root, "real");
    writeFileSync(real, "test-only-sentinel");
    const link = join(secretDir, "redis-password");
    symlinkSync(real, link);
    expect(() => ensurePlatformSecretFile(link)).toThrow(/regular file/);

    rmSync(link);
    mkdirSync(link);
    expect(() => ensurePlatformSecretFile(link)).toThrow(/regular file/);

    rmSync(link, { recursive: true });
    writeFileSync(link, "");
    expect(() => ensurePlatformSecretFile(link)).toThrow(/empty/);
  });

  it("rejects noncanonical existing values instead of trimming or changing bytes", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-password");
    mkdirSync(join(root, "secrets"));

    for (const value of [
      `${canonicalPassword(1)}\n`,
      ` ${canonicalPassword(1)}`,
      `${canonicalPassword(1)}\0`,
      canonicalPassword(1).slice(0, -1),
      "a".repeat(43),
    ]) {
      writeFileSync(path, value);
      expect(() => ensurePlatformSecretFile(path)).toThrow(/canonical/);
    }
  });

  it("rejects an oversized existing source before reading its contents", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-password");
    mkdirSync(join(root, "secrets"));
    writeFileSync(path, "x".repeat(4_097));

    expect(() => ensurePlatformSecretFile(path)).toThrow(/size limit/);
  });

  it("rejects hardlinked secrets before making their shared inode world-readable", () => {
    const root = tempDir();
    const secretDir = join(root, "secrets");
    mkdirSync(secretDir);
    const alias = join(root, "shared-alias");
    writeFileSync(alias, canonicalPassword(4), { mode: 0o600 });
    const path = join(secretDir, "redis-password");
    linkSync(alias, path);
    const beforeRetry = vi.fn();

    expect(() => ensurePlatformSecretFile(path, { publicationHooks: { beforeRetry } })).toThrow(
      /exactly one link/,
    );
    expect(beforeRetry).not.toHaveBeenCalled();
    expect(statSync(alias).mode & 0o777).toBe(0o600);
  });

  it("enforces the protected parent and secret ownership invariant", () => {
    expect(() => assertPlatformSecretParentOwner({ uid: 1001 }, 1000)).toThrow(/invoking user/);
    expect(() => assertPlatformSecretMetadata({ uid: 1001, nlink: 1 }, { uid: 1000 })).toThrow(
      /same owner/,
    );
    expect(() => assertPlatformSecretMetadata({ uid: 1000, nlink: 2 }, { uid: 1000 })).toThrow(
      /exactly one link/,
    );

    const root = tempDir();
    const outside = join(root, "outside");
    mkdirSync(outside);
    symlinkSync(outside, join(root, "secrets"));
    expect(() => ensurePlatformSecretFile(join(root, "secrets", "redis-password"))).toThrow(
      /parent must be a regular directory/,
    );
  });

  it("reuses a valid concurrent winner and removes its losing temporary file", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-password");
    const winner = canonicalPassword(6);

    const result = ensurePlatformSecretFile(path, {
      randomBytes: () => {
        writeFileSync(path, winner, { mode: 0o444 });
        return Buffer.alloc(32, 8);
      },
    });

    expect(result).toBe(winner);
    expect(statSync(path).nlink).toBe(1);
    expect(readdirSync(join(root, "secrets"))).toEqual(["redis-password"]);
  });

  it("retries only the EEXIST publication path while a winner removes its publication link", () => {
    const root = tempDir();
    const secretDir = join(root, "secrets");
    const path = join(secretDir, "redis-password");
    const publicationTemp = join(secretDir, ".winner-publication.tmp");
    const winner = canonicalPassword(10);
    let retryCount = 0;

    const result = ensurePlatformSecretFile(path, {
      randomBytes: () => {
        writeFileSync(publicationTemp, winner, { mode: 0o444 });
        linkSync(publicationTemp, path);
        return Buffer.alloc(32, 11);
      },
      publicationHooks: {
        beforeRetry: () => {
          retryCount += 1;
          rmSync(publicationTemp);
        },
      },
    });

    expect(result).toBe(winner);
    expect(retryCount).toBe(1);
    expect(statSync(path).nlink).toBe(1);
    expect(readdirSync(secretDir)).toEqual(["redis-password"]);
  });

  it("does not report winner success when its publication temporary unlink fails", () => {
    const path = join(tempDir(), "secrets", "redis-password");
    const failure = new Error("injected-winner-publication-cleanup-failure");

    expect(() =>
      ensurePlatformSecretFile(path, {
        randomBytes: () => Buffer.alloc(32, 12),
        temporaryFileOps: {
          unlink: () => {
            throw failure;
          },
        },
      }),
    ).toThrow(failure);
    expect(statSync(path).nlink).toBe(2);
  });

  it("does not report loser success until its own candidate is deleted", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-password");
    const winner = canonicalPassword(13);
    const failure = new Error("injected-loser-publication-cleanup-failure");

    expect(() =>
      ensurePlatformSecretFile(path, {
        randomBytes: () => {
          writeFileSync(path, winner, { mode: 0o444 });
          return Buffer.alloc(32, 14);
        },
        temporaryFileOps: {
          unlink: () => {
            throw failure;
          },
        },
      }),
    ).toThrow(failure);
    expect(readFileSync(path, "utf8")).toBe(winner);
    expect(readdirSync(join(root, "secrets")).filter((name) => name.endsWith(".tmp"))).toHaveLength(
      1,
    );
  });

  it("bounds EEXIST publication retries while cleaning the loser candidate", () => {
    const root = tempDir();
    const secretDir = join(root, "secrets");
    const path = join(secretDir, "redis-password");
    const publicationTemp = join(secretDir, ".persistent-winner-publication.tmp");
    const beforeRetry = vi.fn();
    const retryWait = vi.fn();

    expect(() =>
      ensurePlatformSecretFile(path, {
        randomBytes: () => {
          writeFileSync(publicationTemp, canonicalPassword(15), { mode: 0o444 });
          linkSync(publicationTemp, path);
          return Buffer.alloc(32, 16);
        },
        publicationHooks: { beforeRetry, retryWait },
      }),
    ).toThrow(/exactly one link/);
    expect(beforeRetry).toHaveBeenCalledTimes(24);
    expect(retryWait).toHaveBeenCalledTimes(24);
    expect(statSync(path).nlink).toBe(2);
    expect(readdirSync(secretDir).filter((name) => name.startsWith(".redis-password."))).toEqual(
      [],
    );
  });

  it.each(["write", "fsync", "chmod"] as const)(
    "removes the exact partial temporary file when %s fails",
    (stage) => {
      const root = tempDir();
      const secretDir = join(root, "secrets");
      mkdirSync(secretDir);
      writeFileSync(join(secretDir, "unrelated"), "keep");
      const failure = new Error(`injected-${stage}-failure`);
      const injectedStage =
        stage === "write"
          ? (fd: number) => {
              writeFileSync(fd, "partial-secret-data");
              throw failure;
            }
          : () => {
              throw failure;
            };

      expect(() =>
        ensurePlatformSecretFile(join(secretDir, "redis-password"), {
          randomBytes: () => Buffer.alloc(32, 2),
          temporaryFileOps: {
            [stage]: injectedStage,
          },
        }),
      ).toThrow(failure);
      expect(readdirSync(secretDir)).toEqual(["unrelated"]);
    },
  );

  it("does not mask the original write failure when temporary cleanup also fails", () => {
    const root = tempDir();
    const secretDir = join(root, "secrets");
    mkdirSync(secretDir);
    const original = new Error("injected-original-write-failure");

    expect(() =>
      ensurePlatformSecretFile(join(secretDir, "redis-password"), {
        randomBytes: () => Buffer.alloc(32, 2),
        temporaryFileOps: {
          write: () => {
            throw original;
          },
          unlink: () => {
            throw new Error("injected-cleanup-failure");
          },
        },
      }),
    ).toThrow(original);
    expect(readdirSync(secretDir).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
  });
});

describe("rotatePlatformSecretFile", () => {
  it("atomically replaces an existing canonical secret and ordinary ensure reuses it", () => {
    const path = join(tempDir(), "secrets", "redis-password");
    const first = ensurePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 1) });
    const rotated = rotatePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 2) });

    expect(rotated).toBe(canonicalPassword(2));
    expect(rotated).not.toBe(first);
    expect(readFileSync(path, "utf8")).toBe(rotated);
    expect(statSync(path).nlink).toBe(1);
    expect(ensurePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 3) })).toBe(
      rotated,
    );
  });

  it("requires an existing owner-valid single-link target and never deletes it first", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-password");
    expect(() =>
      rotatePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 2) }),
    ).toThrow(/existing platform secret/);
    expect(() => readFileSync(path, "utf8")).toThrow();

    const original = ensurePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 1) });
    const alias = join(root, "alias");
    linkSync(path, alias);
    expect(() =>
      rotatePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 2) }),
    ).toThrow(/exactly one link/);
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it.each(["write", "fsync", "chmod"] as const)(
    "preserves the authoritative secret when candidate %s fails",
    (stage) => {
      const path = join(tempDir(), "secrets", "redis-password");
      const original = ensurePlatformSecretFile(path, { randomBytes: () => Buffer.alloc(32, 1) });
      const failure = new Error(`injected-rotation-${stage}-failure`);

      expect(() =>
        rotatePlatformSecretFile(path, {
          randomBytes: () => Buffer.alloc(32, 2),
          temporaryFileOps: {
            [stage]: () => {
              throw failure;
            },
          },
        }),
      ).toThrow(failure);
      expect(readFileSync(path, "utf8")).toBe(original);
      expect(readdirSync(join(path, "..")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
    },
  );
});

describe("writePlatformFileAtomically", () => {
  it("replaces a derived file without leaving a temporary file", () => {
    const root = tempDir();
    const path = join(root, "secrets", "redis-acl.conf");
    writePlatformFileAtomically(path, "first\n");
    writePlatformFileAtomically(path, "second\n");

    expect(readFileSync(path, "utf8")).toBe("second\n");
    expect(lstatSync(path).isFile()).toBe(true);
    expect(readdirSync(join(root, "secrets"))).toEqual(["redis-acl.conf"]);
  });
});
