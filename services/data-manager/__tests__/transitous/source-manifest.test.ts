import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanGtfsArchives } from "../../src/jobs/transitous/internal.js";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
import { buildJobContext } from "../../src/jobs/transitous/pipeline.js";
import {
  finalizeTransitSourceManifest,
  readTransitSourceManifest,
  writeTransitSourceManifest,
} from "../../src/jobs/transitous/source-manifest.js";
import { StateStore } from "../../src/state.js";
import { atomicWriteFile } from "../../src/utils/atomic-write.js";

const CHUNK = 64 * 1024;

const probe = vi.hoisted(() => ({
  opened: [] as string[],
  openNow: 0,
  maxOpen: 0,
  closed: 0,
  readLengths: [] as number[],
  bufferSizes: [] as number[],
  onRead: undefined as undefined | ((path: string, readIndex: number) => void | Promise<void>),
  onPublish: undefined as undefined | (() => void),
  /** Descriptor stats keep reporting the first snapshot, as on a coarse-ctime filesystem. */
  freezeDescriptorStat: false,
}));

// Only the I/O boundaries are observed; every call still reaches the real
// implementation, so the finalizer's own logic is exercised unmodified.
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      const handle = await actual.open(...args);
      const path = String(args[0]);
      if (!path.endsWith(".zip")) return handle;
      probe.opened.push(path);
      probe.openNow += 1;
      probe.maxOpen = Math.max(probe.maxOpen, probe.openNow);
      let readIndex = 0;
      let closed = false;
      let firstStat: Promise<unknown> | undefined;
      return new Proxy(handle, {
        get(target, property) {
          if (property === "read") {
            return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
              probe.readLengths.push(length);
              probe.bufferSizes.push(buffer.byteLength);
              await probe.onRead?.(path, readIndex++);
              return target.read(buffer, offset, length, position);
            };
          }
          if (property === "stat" && probe.freezeDescriptorStat) {
            return (...statArgs: Parameters<FileHandle["stat"]>) => {
              firstStat ??= target.stat(...statArgs);
              return firstStat;
            };
          }
          if (property === "close") {
            return async () => {
              if (!closed) {
                closed = true;
                probe.openNow -= 1;
                probe.closed += 1;
              }
              return target.close();
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }) as FileHandle;
    },
  };
});

vi.mock("../../src/jobs/transitous/internal.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/jobs/transitous/internal.js")>();
  return { ...actual, scanGtfsArchives: vi.fn(actual.scanGtfsArchives) };
});

vi.mock("../../src/utils/atomic-write.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/atomic-write.js")>();
  return {
    ...actual,
    atomicWriteFile: vi.fn(async (...args: Parameters<typeof actual.atomicWriteFile>) => {
      probe.onPublish?.();
      return actual.atomicWriteFile(...args);
    }),
  };
});

type SourceInput = {
  region?: string;
  name: string;
  format?: "gtfs" | "netex";
  origin?: "catalog" | "operator";
  originUrl?: string;
};

let tmp: string | undefined;

function makeCtx(sources: SourceInput[], options: { abortSignal?: AbortSignal } = {}) {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-transit-manifest-"));
  mkdirSync(join(tmp, "gtfs"), { recursive: true });
  const ctx = buildJobContext({
    dataDir: tmp,
    countries: ["de"],
    source: "build",
    operationsPolicy: resolveOperationsProfile({
      profile: "regional-sovereign",
      countries: ["de"],
      source: "build",
      osmInput: "germany.osm.pbf",
    }),
    store: new StateStore(tmp),
    now: () => "2026-07-15T12:00:00.000Z",
    abortSignal: options.abortSignal,
  });
  ctx.state.selectedFeedFiles = [
    {
      id: "de",
      country: "de",
      path: "feeds/de.json",
      url: "catalog",
      activeScheduleSources: sources.map((source) => ({
        id: `${source.region ?? "de"}_${source.name}`,
        sourceId: `${source.origin ?? "catalog"}:${source.region ?? "de"}:${source.name}`,
        region: source.region ?? "de",
        name: source.name,
        format: source.format ?? "gtfs",
        origin: source.origin ?? "catalog",
        ...(source.originUrl ? { originUrl: source.originUrl } : {}),
        license: { "spdx-identifier": "CC-BY-4.0" },
      })),
    },
  ];
  return ctx;
}

function payload(size: number): Buffer {
  const bytes = Buffer.alloc(size);
  for (let index = 0; index < size; index++) bytes[index] = (index * 31 + 7) % 251;
  return bytes;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

type FinalSource = {
  sourceId: string;
  format: string;
  artifact: { relativePath: string; sha256: string; sizeBytes: number; modifiedAt: string };
};

function readSources(path: string): FinalSource[] {
  return (JSON.parse(readFileSync(path, "utf-8")) as { sources: FinalSource[] }).sources;
}

beforeEach(() => {
  probe.opened.length = 0;
  probe.openNow = 0;
  probe.maxOpen = 0;
  probe.closed = 0;
  probe.readLengths.length = 0;
  probe.bufferSizes.length = 0;
  probe.onRead = undefined;
  probe.onPublish = undefined;
  probe.freezeDescriptorStat = false;
});

afterEach(() => {
  vi.mocked(scanGtfsArchives).mockClear();
  vi.mocked(atomicWriteFile).mockClear();
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

describe("transit acquisition manifest", () => {
  it("is produced for every profile, omits operator relay URLs, and hashes each artifact", async () => {
    const ctx = makeCtx([
      {
        name: "BVG",
        origin: "operator",
        originUrl: "https://operator.example/gtfs?api_key=secret",
      },
    ]);

    const manifestPath = writeTransitSourceManifest(ctx);
    writeFileSync(join(ctx.outDir, "de_BVG.gtfs.zip"), "pinned feed bytes");
    await finalizeTransitSourceManifest(ctx);

    const text = readFileSync(manifestPath as string, "utf-8");
    expect(text).not.toContain("secret");
    const manifest = JSON.parse(text) as {
      sources: Array<{
        originUrl?: string;
        artifact: { relativePath: string; sha256: string; sizeBytes: number };
      }>;
    };
    expect(manifest.sources[0]?.originUrl).toBeUndefined();
    expect(manifest.sources[0]?.artifact.relativePath).toBe("de_BVG.gtfs.zip");
    expect(manifest.sources[0]?.artifact.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.sources[0]?.artifact.sizeBytes).toBe(17);
    expect(readTransitSourceManifest(manifestPath).profileEvidence?.profile).toBe(
      "regional-sovereign",
    );
  });

  it("fails completeness when any desired source artifact is absent", async () => {
    const ctx = makeCtx([{ name: "vbb" }]);
    writeTransitSourceManifest(ctx);
    await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/has no acquired artifact/);
  });

  describe("digest, metadata and ordering", () => {
    it("matches an independent digest, size and mtime for empty and multi-chunk artifacts", async () => {
      const sizes = { a: 0, b: 1, c: CHUNK, d: CHUNK * 2 + 17 };
      const ctx = makeCtx(Object.keys(sizes).map((name) => ({ name })));
      writeTransitSourceManifest(ctx);
      const expected = new Map<string, { bytes: Buffer; mtime: Date }>();
      for (const [name, size] of Object.entries(sizes)) {
        const bytes = payload(size);
        const mtime = new Date(Date.UTC(2026, 0, 2, 3, 4, 5, 678));
        const file = join(ctx.outDir, `de_${name}.gtfs.zip`);
        writeFileSync(file, bytes);
        utimesSync(file, mtime, mtime);
        expected.set(`catalog:de:${name}`, { bytes, mtime });
      }

      const manifestPath = await finalizeTransitSourceManifest(ctx);

      const sources = readSources(manifestPath);
      expect(sources.map((source) => source.sourceId)).toEqual([
        "catalog:de:a",
        "catalog:de:b",
        "catalog:de:c",
        "catalog:de:d",
      ]);
      for (const source of sources) {
        const want = expected.get(source.sourceId);
        expect(source.format).toBe("gtfs");
        expect(source.artifact.sha256).toBe(sha256(want?.bytes as Buffer));
        expect(source.artifact.sizeBytes).toBe(want?.bytes.byteLength);
        expect(source.artifact.modifiedAt).toBe(want?.mtime.toISOString());
        expect(source.artifact.relativePath).toBe(`de_${source.sourceId.split(":")[2]}.gtfs.zip`);
      }
      expect(readTransitSourceManifest(manifestPath).sources).toHaveLength(4);
    });

    it("records the same modifiedAt as Stats.mtime for sub-millisecond and pre-epoch timestamps", async () => {
      // Node treats a negative numeric time as "now", so pre-epoch must be a Date.
      const times: Array<number | Date> = [
        1700000000.0004,
        1700000000.0005,
        1700000000.0006,
        1700000000.9996,
        new Date(-86400123),
      ];
      const ctx = makeCtx(times.map((_, index) => ({ name: `t${index}` })));
      writeTransitSourceManifest(ctx);
      const expected = new Map<string, string>();
      times.forEach((time, index) => {
        const file = join(ctx.outDir, `de_t${index}.gtfs.zip`);
        writeFileSync(file, payload(index + 1));
        utimesSync(file, time, time);
        expected.set(`catalog:de:t${index}`, statSync(file).mtime.toISOString());
      });
      // A negative numeric utimes value is replaced by "now", so the pre-epoch
      // case must really be stored before the Stats.mtime comparison means anything.
      const preEpochFile = join(ctx.outDir, `de_t${times.length - 1}.gtfs.zip`);
      expect(statSync(preEpochFile).mtimeMs).toBeLessThan(0);
      // The filesystem decides what was actually stored. At least one value must
      // round up, which a truncating conversion would get wrong.
      const roundedUp = times.filter((_, index) => {
        const { mtimeNs } = statSync(join(ctx.outDir, `de_t${index}.gtfs.zip`), { bigint: true });
        const truncated = new Date(Number(mtimeNs / 1_000_000n)).toISOString();
        return truncated !== expected.get(`catalog:de:t${index}`);
      });
      expect(roundedUp.length).toBeGreaterThan(0);

      const manifestPath = await finalizeTransitSourceManifest(ctx);

      for (const source of readSources(manifestPath)) {
        expect(source.artifact.modifiedAt).toBe(expected.get(source.sourceId));
      }
    });

    it("reads each artifact in bounded chunks with at most one owned handle at a time", async () => {
      const ctx = makeCtx([{ name: "big" }, { name: "small" }]);
      writeTransitSourceManifest(ctx);
      writeFileSync(join(ctx.outDir, "de_big.gtfs.zip"), payload(CHUNK * 3 + 5));
      writeFileSync(join(ctx.outDir, "de_small.gtfs.zip"), payload(10));

      await finalizeTransitSourceManifest(ctx);

      expect(probe.opened).toHaveLength(2);
      expect(probe.maxOpen).toBe(1);
      expect(probe.openNow).toBe(0);
      expect(probe.closed).toBe(2);
      expect(probe.readLengths.length).toBeGreaterThanOrEqual(5);
      expect(Math.max(...probe.readLengths)).toBeLessThanOrEqual(CHUNK);
      expect(Math.max(...probe.bufferSizes)).toBeLessThanOrEqual(CHUNK);
      expect(probe.readLengths.reduce((sum, length) => sum + length, 0)).toBe(CHUNK * 3 + 5 + 10);
    });

    it("yields to the event loop before it resolves and before publication", async () => {
      const ctx = makeCtx([{ name: "big" }]);
      writeTransitSourceManifest(ctx);
      writeFileSync(join(ctx.outDir, "de_big.gtfs.zip"), payload(CHUNK * 4));
      let ticks = 0;
      let ticksAtPublish: number | undefined;
      const tick = () => {
        ticks += 1;
        timer = setImmediate(tick);
      };
      let timer = setImmediate(tick);
      const ticksAtRead: number[] = [];
      probe.onRead = () => {
        ticksAtRead.push(ticks);
      };
      probe.onPublish = () => {
        ticksAtPublish = ticks;
      };

      try {
        await finalizeTransitSourceManifest(ctx);
      } finally {
        clearImmediate(timer);
      }

      expect(ticks).toBeGreaterThan(0);
      expect(ticksAtRead.at(-1)).toBeGreaterThan(0);
      expect(ticksAtPublish).toBeGreaterThanOrEqual(ticksAtRead.at(-1) as number);
    });

    it("indexes a 500-source inventory once instead of rescanning it per source", async () => {
      const count = 500;
      const names = Array.from(
        { length: count },
        (_, index) => `s${String(index).padStart(3, "0")}`,
      );
      const ctx = makeCtx(names.map((name) => ({ name })));
      writeTransitSourceManifest(ctx);
      const idReads = new Map<string, number>();
      const inventory = names.map((name) => {
        const path = join(ctx.outDir, `de_${name}.gtfs.zip`);
        writeFileSync(path, name);
        return {
          path,
          sizeBytes: name.length,
          get id() {
            idReads.set(name, (idReads.get(name) ?? 0) + 1);
            return `de_${name}`;
          },
        };
      });
      vi.mocked(scanGtfsArchives).mockReturnValueOnce(inventory);

      const manifestPath = await finalizeTransitSourceManifest(ctx);

      expect(scanGtfsArchives).toHaveBeenCalledTimes(1);
      expect(idReads.size).toBe(count);
      expect([...idReads.values()].every((reads) => reads === 1)).toBe(true);
      const sources = readSources(manifestPath);
      expect(sources.map((source) => source.artifact.relativePath)).toEqual(
        names.map((name) => `de_${name}.gtfs.zip`),
      );
      expect(probe.maxOpen).toBe(1);
    });
  });

  describe("artifact selection", () => {
    it("prefers the declared format over the alternate", async () => {
      const ctx = makeCtx([
        { name: "g", format: "gtfs" },
        { name: "n", format: "netex" },
      ]);
      writeTransitSourceManifest(ctx);
      for (const name of ["g", "n"]) {
        writeFileSync(join(ctx.outDir, `de_${name}.gtfs.zip`), "gtfs");
        writeFileSync(join(ctx.outDir, `de_${name}.netex.zip`), "netex");
      }

      const sources = readSources(await finalizeTransitSourceManifest(ctx));

      expect(sources.map((source) => [source.format, source.artifact.relativePath])).toEqual([
        ["gtfs", "de_g.gtfs.zip"],
        ["netex", "de_n.netex.zip"],
      ]);
    });

    it("falls back to the alternate format and records the acquired format", async () => {
      const ctx = makeCtx([{ name: "fb", format: "gtfs" }]);
      writeTransitSourceManifest(ctx);
      writeFileSync(join(ctx.outDir, "de_fb.netex.zip"), "netex only");

      const [source] = readSources(await finalizeTransitSourceManifest(ctx));

      expect(source?.format).toBe("netex");
      expect(source?.artifact.relativePath).toBe("de_fb.netex.zip");
    });

    it("matches artifact identity case-insensitively", async () => {
      const ctx = makeCtx([{ region: "DE", name: "BvG" }]);
      writeTransitSourceManifest(ctx);
      writeFileSync(join(ctx.outDir, "de_BVG.gtfs.zip"), "case");

      const [source] = readSources(await finalizeTransitSourceManifest(ctx));

      expect(source?.artifact.relativePath).toBe("de_BVG.gtfs.zip");
    });

    it("rejects more than one preferred candidate", async () => {
      const ctx = makeCtx([{ name: "dup" }]);
      writeTransitSourceManifest(ctx);
      vi.mocked(scanGtfsArchives).mockReturnValueOnce([
        { id: "de_dup", path: join(ctx.outDir, "de_dup.gtfs.zip"), sizeBytes: 1 },
        { id: "DE_dup", path: join(ctx.outDir, "DE_dup.gtfs.zip"), sizeBytes: 1 },
      ]);

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/ambiguous gtfs artifacts/);
      expect(probe.opened).toEqual([]);
    });

    it("rejects more than one fallback candidate when the preferred format is absent", async () => {
      const ctx = makeCtx([{ name: "dup" }]);
      writeTransitSourceManifest(ctx);
      vi.mocked(scanGtfsArchives).mockReturnValueOnce([
        { id: "de_dup", path: join(ctx.outDir, "de_dup.netex.zip"), sizeBytes: 1 },
        { id: "DE_dup", path: join(ctx.outDir, "DE_dup.netex.zip"), sizeBytes: 1 },
      ]);

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/ambiguous netex artifacts/);
      expect(probe.opened).toEqual([]);
    });

    it("does not let an ambiguous unused fallback block a unique preferred artifact", async () => {
      const ctx = makeCtx([{ name: "dup" }]);
      writeTransitSourceManifest(ctx);
      const preferred = join(ctx.outDir, "de_dup.gtfs.zip");
      writeFileSync(preferred, "preferred");
      vi.mocked(scanGtfsArchives).mockReturnValueOnce([
        { id: "de_dup", path: preferred, sizeBytes: 9 },
        { id: "de_dup", path: join(ctx.outDir, "de_dup.netex.zip"), sizeBytes: 1 },
        { id: "DE_dup", path: join(ctx.outDir, "DE_dup.netex.zip"), sizeBytes: 1 },
      ]);

      const [source] = readSources(await finalizeTransitSourceManifest(ctx));

      expect(source?.format).toBe("gtfs");
      expect(source?.artifact.relativePath).toBe("de_dup.gtfs.zip");
    });
  });

  describe("failure ownership", () => {
    function prepare(options: { abortSignal?: AbortSignal } = {}) {
      const ctx = makeCtx([{ name: "a" }, { name: "b" }], options);
      const manifestPath = writeTransitSourceManifest(ctx);
      const first = join(ctx.outDir, "de_a.gtfs.zip");
      writeFileSync(first, payload(CHUNK * 3));
      writeFileSync(join(ctx.outDir, "de_b.gtfs.zip"), payload(CHUNK + 3));
      const draft = readFileSync(manifestPath);
      return { ctx, manifestPath, first, draft };
    }

    function expectNothingPublished(manifestPath: string, draft: Buffer) {
      expect(readFileSync(manifestPath).equals(draft)).toBe(true);
      expect(atomicWriteFile).not.toHaveBeenCalled();
      expect(probe.openNow).toBe(0);
      expect(probe.closed).toBe(probe.opened.length);
    }

    it("closes the handle and publishes nothing when a read fails", async () => {
      const { ctx, manifestPath, draft } = prepare();
      probe.onRead = (_path, index) => {
        if (index === 1) throw Object.assign(new Error("read failed"), { code: "EIO" });
      };

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/read failed/);

      expect(probe.opened).toHaveLength(1);
      expectNothingPublished(manifestPath, draft);
    });

    it("rejects a file appended to in place while it is being read", async () => {
      const { ctx, manifestPath, first, draft } = prepare();
      probe.onRead = (_path, index) => {
        if (index === 0) appendFileSync(first, "late");
      };

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/changed/i);

      expectNothingPublished(manifestPath, draft);
    });

    it("rejects a file truncated while it is being read", async () => {
      const { ctx, manifestPath, first, draft } = prepare();
      probe.onRead = (_path, index) => {
        if (index === 0) truncateSync(first, CHUNK / 2);
      };

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/changed|truncated/i);

      expectNothingPublished(manifestPath, draft);
    });

    it("rejects a same-size in-place rewrite", async () => {
      const { ctx, manifestPath, first, draft } = prepare();
      probe.onRead = (_path, index) => {
        if (index === 0) {
          writeFileSync(first, payload(CHUNK * 3).reverse());
          const later = new Date(Date.UTC(2030, 0, 1));
          utimesSync(first, later, later);
        }
      };

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/changed/i);

      expectNothingPublished(manifestPath, draft);
    });

    it("rejects a path replaced by a different file while it is being read", async () => {
      const { ctx, manifestPath, first, draft } = prepare();
      // The descriptor still names the original file, so only the path check can notice.
      probe.freezeDescriptorStat = true;
      probe.onRead = (_path, index) => {
        if (index === 0) {
          const replacement = join(ctx.outDir, "replacement.tmp");
          writeFileSync(replacement, payload(CHUNK * 3));
          renameSync(replacement, first);
        }
      };

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/changed|replaced/i);

      expectNothingPublished(manifestPath, draft);
    });

    it("stops without publishing when aborted during a read", async () => {
      const controller = new AbortController();
      const { ctx, manifestPath, draft } = prepare({ abortSignal: controller.signal });
      probe.onRead = (_path, index) => {
        if (index === 0) controller.abort(new Error("job aborted"));
      };

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/job aborted/);

      expect(probe.opened).toHaveLength(1);
      expectNothingPublished(manifestPath, draft);
    });

    it("does not open any artifact when already aborted", async () => {
      const controller = new AbortController();
      controller.abort(new Error("already aborted"));
      const { ctx, manifestPath, draft } = prepare({ abortSignal: controller.signal });

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/already aborted/);

      expect(probe.opened).toEqual([]);
      expectNothingPublished(manifestPath, draft);
    });

    it("keeps the previous complete manifest when a later regeneration fails", async () => {
      const { ctx, manifestPath } = prepare();
      const complete = await finalizeTransitSourceManifest(ctx);
      const previous = readFileSync(complete);
      probe.onRead = (_path, index) => {
        if (index === 0) throw new Error("second run failed");
      };
      vi.mocked(atomicWriteFile).mockClear();

      await expect(finalizeTransitSourceManifest(ctx)).rejects.toThrow(/second run failed/);

      expect(readFileSync(manifestPath).equals(previous)).toBe(true);
      expect(atomicWriteFile).not.toHaveBeenCalled();
      expect(probe.openNow).toBe(0);
    });
  });
});
