import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  commitConfigurationGeneration,
  currentConfigurationGeneration,
  readAppliedServiceIds,
} from "../configuration-generation";
import { CONFIGURATION_GENERATIONS, SERVICE_SELECTION_FILE } from "../deployment";
import type { LoadedService } from "../types";

// Only schedule real filesystem operations at syscall boundaries. No product hooks,
// fake file data, sleeps, or replaced configuration/writer behavior.
const seam = vi.hoisted(() => ({
  afterStat: undefined as ((path: string) => void) | undefined,
  beforeRead: undefined as ((path: string) => void) | undefined,
  afterRead: undefined as ((path: string) => void) | undefined,
  afterFstat: undefined as ((descriptor: number) => void) | undefined,
  readLimit: Number.POSITIVE_INFINITY,
  opened: new Map<number, string>(),
  closed: [] as string[],
  fifoPaths: new Set<string>(),
  reads: [] as Array<{ path: string; allocation: number; length: number }>,
  flags: [] as number[],
}));
vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      const stats = fs.lstatSync(...args);
      seam.afterStat?.(String(args[0]));
      return stats;
    },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      // A regression must fail, not hang the runner opening a FIFO without a writer.
      if (seam.fifoPaths.has(String(args[0])) && !(Number(args[1]) & fs.constants.O_NONBLOCK)) {
        throw new Error("Test fixture refuses a blocking FIFO open");
      }
      const descriptor = fs.openSync(...args);
      seam.opened.set(descriptor, String(args[0]));
      seam.flags.push(Number(args[1]));
      return descriptor;
    },
    closeSync: (descriptor: number) => {
      fs.closeSync(descriptor);
      seam.closed.push(seam.opened.get(descriptor) ?? "");
      seam.opened.delete(descriptor);
    },
    fstatSync: (...args: Parameters<typeof fs.fstatSync>) => {
      const stats = fs.fstatSync(...args);
      seam.afterFstat?.(args[0]);
      return stats;
    },
    readSync: (
      descriptor: number,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) => {
      const path = seam.opened.get(descriptor) ?? "";
      seam.beforeRead?.(path);
      seam.reads.push({ path, allocation: buffer.length, length });
      const count = fs.readSync(
        descriptor,
        buffer,
        offset,
        Math.min(length, seam.readLimit),
        position,
      );
      seam.afterRead?.(path);
      return count;
    },
    readFileSync: (...args: Parameters<typeof fs.readFileSync>) => {
      const path = String(args[0]);
      seam.beforeRead?.(path);
      const contents = fs.readFileSync(...args);
      seam.afterRead?.(path);
      return contents;
    },
  };
});

const roots: string[] = [];
afterEach(() => {
  seam.afterStat = seam.beforeRead = seam.afterRead = undefined;
  seam.afterFstat = undefined;
  seam.readLimit = Number.POSITIVE_INFINITY;
  seam.closed.length = 0;
  seam.fifoPaths.clear();
  seam.reads.length = seam.flags.length = 0;
  try {
    expect([...seam.opened.values()]).toEqual([]);
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

const services: LoadedService[] = ["alpha", "beta"].map((id) => ({
  manifest: {
    id,
    name: id,
    version: "1.0.0",
    quality: "built-in",
    container: { image: `example/${id}`, tag: "1" },
    configSchema: {
      type: "object",
      properties: { TOKEN: { type: "string", "x-openmapx-secret": true } },
    },
  },
  directory: `/trusted/services/${id}`,
  isBuiltIn: true,
  enabled: false,
}));
const input = {
  domain: "maps.example.test",
  selectedRoots: ["alpha"],
  serviceConfigs: [],
  integrationConfigs: [],
  serviceSecrets: [{ serviceId: "alpha", values: { TOKEN: "synthetic-secret" } }],
};

async function fixture(reader: "selection" | "digest") {
  const root = mkdtempSync(join(tmpdir(), "openmapx-generation-readers-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const first = await commitConfigurationGeneration({ infraDir, services, input });
  const generation = join(infraDir, CONFIGURATION_GENERATIONS, first.revisionId);
  const target = join(generation, SERVICE_SELECTION_FILE);
  const previous =
    reader === "digest"
      ? await commitConfigurationGeneration({
          infraDir,
          services,
          input: { ...input, selectedRoots: ["beta"] },
        })
      : first;
  return {
    root,
    infraDir,
    generation,
    target,
    run: async (arm: () => void) => {
      if (reader === "selection") {
        arm();
        return readAppliedServiceIds(infraDir, services);
      }
      return commitConfigurationGeneration({
        infraDir,
        services,
        input,
        revisionId: first.revisionId,
        beforeCommit: async () => arm(),
      });
    },
    assertRetained: () => {
      expect(currentConfigurationGeneration(infraDir)).toBe(previous.revisionId);
      expect(existsSync(join(infraDir, ".trusted-config-writer"))).toBe(false);
      expect(
        readdirSync(join(infraDir, CONFIGURATION_GENERATIONS)).every(
          (name) => !name.startsWith("."),
        ),
      ).toBe(true);
    },
  };
}

function afterReaderCheck(target: string, change: () => void) {
  let checks = 0;
  seam.afterStat = (path) => {
    // The first lstat belongs to safeGenerationTree; the second is the
    // vulnerable reader's metadata check, immediately before its open/read.
    if (path === target && ++checks === 2) {
      seam.afterStat = undefined;
      change();
    }
  };
}

describe.each(["selection", "digest"] as const)("same-descriptor %s reader", (reader) => {
  it("rejects a FIFO replacement without waiting for a writer and closes its descriptor", async () => {
    const f = await fixture(reader);
    const backup = join(f.root, "original");
    let changed = false;
    try {
      await expectRejected(
        f.run(() =>
          afterReaderCheck(f.target, () => {
            renameSync(f.target, backup);
            execFileSync("mkfifo", [f.target], { timeout: 1000 });
            seam.fifoPaths.add(f.target);
            changed = true;
          }),
        ),
        reader,
      );
      expect(changed).toBe(true);
      expect(seam.closed).toContain(f.target);
      expect(seam.reads.filter(({ path }) => path === f.target)).toEqual([]);
    } finally {
      if (existsSync(backup)) {
        rmSync(f.target);
        renameSync(backup, f.target);
      }
    }
    f.assertRetained();
  });

  it.each(["symlink", "regular"] as const)(
    "rejects %s replacement between check and open",
    async (kind) => {
      const f = await fixture(reader);
      const original = readFileSync(f.target);
      const replacement = join(f.root, "replacement");
      const backup = join(f.root, "original");
      writeFileSync(replacement, original, { mode: 0o600 });
      let changed = false;
      const restore = () => {
        seam.afterRead = undefined;
        if (existsSync(backup)) {
          rmSync(f.target);
          renameSync(backup, f.target);
        }
      };
      try {
        const run = f.run(() =>
          afterReaderCheck(f.target, () => {
            changed = true;
            renameSync(f.target, backup);
            if (kind === "regular") renameSync(replacement, f.target);
            else {
              symlinkSync(replacement, f.target);
              // Restore after an unsafe path read, before later tree validation:
              // a transient symlink must not pass merely because it disappeared.
              seam.afterRead = (path) => {
                if (path === f.target) restore();
              };
            }
          }),
        );
        await expectRejected(run, reader);
        expect(changed).toBe(true);
      } finally {
        restore();
      }
      f.assertRetained();
    },
  );

  it.each(["growth", "truncation", "same-size rewrite"] as const)(
    "rejects %s during the read and closes descriptors",
    async (kind) => {
      const f = await fixture(reader);
      let changed = false;
      const run = f.run(() => {
        const change = (path: string) => {
          if (path !== f.target) return;
          seam.beforeRead = seam.afterRead = undefined;
          changed = true;
          if (kind === "growth") appendFileSync(path, " ".repeat(2 * 1024 * 1024));
          else if (kind === "truncation") writeFileSync(path, '{"selected":["alpha"]}');
          else {
            const original = readFileSync(path, "utf8");
            writeFileSync(path, original.replace("  ", " \t"));
          }
        };
        if (kind === "same-size rewrite") seam.afterRead = change;
        else seam.beforeRead = change;
      });
      await expectRejected(run, reader);
      expect(changed).toBe(true);
      for (const read of seam.reads.filter(({ path }) => path === f.target)) {
        expect(read.allocation).toBeLessThanOrEqual(64 * 1024);
        expect(read.length).toBeLessThanOrEqual(read.allocation);
      }
      // Restore a valid tree for the independent pointer/cleanup assertion.
      writeFileSync(f.target, '{"selected":["alpha"]}');
      f.assertRetained();
    },
  );

  it.each(["permissions", "hardlink", "oversized"] as const)(
    "rejects %s appearing after tree validation",
    async (kind) => {
      const f = await fixture(reader);
      const original = readFileSync(f.target);
      const link = join(f.root, "extra-link");
      let changed = false;
      await expectRejected(
        f.run(() => {
          seam.afterStat = (path) => {
            if (path !== f.target) return;
            seam.afterStat = undefined;
            changed = true;
            if (kind === "permissions") chmodSync(path, 0o644);
            else if (kind === "hardlink") linkSync(path, link);
            else appendFileSync(path, " ".repeat(2 * 1024 * 1024));
          };
        }),
        reader,
      );
      expect(changed).toBe(true);
      expect(seam.reads.filter(({ path }) => path === f.target)).toEqual([]);
      rmSync(link, { force: true });
      chmodSync(f.target, 0o600);
      writeFileSync(f.target, original);
      f.assertRetained();
    },
  );

  it.each(["fstat", "read"] as const)(
    "closes the actual descriptor when %s throws",
    async (fault) => {
      const f = await fixture(reader);
      let descriptor: number | undefined;
      const fail = () => {
        descriptor = [...seam.opened].find(([, path]) => path === f.target)?.[0];
        throw new Error(`injected ${fault} failure`);
      };
      await expectRejected(
        f.run(() => {
          if (fault === "fstat")
            seam.afterFstat = (fd) => {
              if (seam.opened.get(fd) === f.target) fail();
            };
          else
            seam.beforeRead = (path) => {
              if (path === f.target) fail();
            };
        }),
        reader,
      );
      seam.afterFstat = seam.beforeRead = undefined;
      if (descriptor === undefined) throw new Error("Reader did not open the target file");
      const closedDescriptor = descriptor;
      expect(() => fstatSync(closedDescriptor)).toThrow(expect.objectContaining({ code: "EBADF" }));
      f.assertRetained();
    },
  );

  it("accepts an unchanged private generation, including 0444 secrets, and closes descriptors", async () => {
    const f = await fixture(reader);
    seam.readLimit = 3; // Real short reads must be accumulated rather than parsed/hashed partially.
    const result = await f.run(() => {});
    if (reader === "selection") expect(result).toEqual(new Set(["alpha"]));
    else expect(result).toMatchObject({ enabledServiceIds: ["alpha"] });
    expect(seam.flags.length).toBeGreaterThan(0);
    for (const flags of seam.flags) {
      expect(flags & constants.O_NOFOLLOW).toBe(constants.O_NOFOLLOW);
      expect(flags & constants.O_NONBLOCK).toBe(constants.O_NONBLOCK);
    }
  });
});

async function expectRejected(run: Promise<unknown>, reader: "selection" | "digest") {
  await expect(run).rejects.toThrow();
  if (reader === "digest") {
    await expect(run).rejects.toMatchObject({
      result: { outcome: "not_committed", reason: "failed", cleanupFailed: false },
    });
  }
}

describe("applied-selection parsing and byte limit", () => {
  it.each([0o400, 0o600])("accepts a %s selection exactly at the 64 KiB limit", async (mode) => {
    const f = await fixture("selection");
    const json = '{"selected":["alpha","alpha"]}';
    writeFileSync(f.target, json.padEnd(64 * 1024, " "));
    chmodSync(f.target, mode);
    expect(readAppliedServiceIds(f.infraDir, services)).toEqual(new Set(["alpha"]));
    chmodSync(f.target, 0o600);
    appendFileSync(f.target, " ");
    expect(() => readAppliedServiceIds(f.infraDir, services)).toThrow();
  });

  it.each([
    '{"selected":"alpha"}',
    '{"selected":[1]}',
    '{"selected":["alpha"],"extra":true}',
    '{"selected":["missing"]}',
    Buffer.from([0xff]),
  ])("rejects malformed or uninstalled selection %s", async (contents) => {
    const f = await fixture("selection");
    writeFileSync(f.target, contents);
    expect(() => readAppliedServiceIds(f.infraDir, services)).toThrow();
  });
});
