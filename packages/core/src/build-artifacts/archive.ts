import { createHash } from "node:crypto";
import {
  constants as C,
  closeSync,
  createReadStream,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  realpathSync,
  type Stats,
  writeSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Readable, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createInflateRaw } from "node:zlib";
import { pack } from "tar-stream";
import { AnchoredDirectory, identity, sameInode, withDirectories } from "./filesystem";
import {
  artifactFingerprint,
  BUNDLE_MANIFEST_PATH,
  type BuildRecord,
  type BuildRecordV2,
  type BundleFile,
  type BundleManifest,
  buildArtifactSpec,
  parseBundleManifest,
  portableMotisSourcesSchema,
  safeArtifactPath,
} from "./manifest";
export interface ArtifactArchiveLimits {
  maxUploadBytes: number;
  maxExpandedBytes: number;
  maxStageBytes: number;
  maxEntryBytes: number;
  maxEntries: number;
  maxManifestBytes: number;
  maxPathBytes: number;
  maxPathDepth: number;
  maxExtendedHeaderBytes: number;
  maxExpansionRatio: number;
  expansionRatioThresholdBytes: number;
}
export const DEFAULT_ARTIFACT_ARCHIVE_LIMITS: Readonly<ArtifactArchiveLimits> = Object.freeze({
  maxUploadBytes: 1_099_511_627_776,
  maxExpandedBytes: 2_199_023_255_552,
  maxStageBytes: 4_398_046_511_104,
  maxEntryBytes: 2_199_023_255_552,
  maxEntries: 250_000,
  maxManifestBytes: 67_108_864,
  maxPathBytes: 4096,
  maxPathDepth: 64,
  maxExtendedHeaderBytes: 16384,
  maxExpansionRatio: 1000,
  expansionRatioThresholdBytes: 67_108_864,
});
export type ValidatedBuildBundle = {
  manifest: BundleManifest;
  archiveSha256: string;
  expandedBytes: number;
  manifestSha256: string;
  artifactFingerprint: string;
};
function checkLimits(limits: ArtifactArchiveLimits) {
  if (
    Object.keys(DEFAULT_ARTIFACT_ARCHIVE_LIMITS).some(
      (k) =>
        !Number.isSafeInteger(limits[k as keyof ArtifactArchiveLimits]) ||
        limits[k as keyof ArtifactArchiveLimits] <= 0,
    )
  )
    throw Error("Archive limits must be positive safe integers");
  if (
    limits.maxEntries > 1_000_000 ||
    limits.maxManifestBytes > 268_435_456 ||
    limits.maxPathBytes > 4096 ||
    limits.maxPathDepth > 64 ||
    limits.maxExtendedHeaderBytes > 16384 ||
    limits.maxExpansionRatio > 1000
  )
    throw Error("Archive limits exceed supported ceiling");
}
class Bytes {
  private pending = Buffer.alloc(0);
  private done = false;
  private readonly iterator: AsyncIterator<Buffer>;
  constructor(source: AsyncIterable<Buffer>) {
    this.iterator = source[Symbol.asyncIterator]();
  }
  async take(maximum: number): Promise<Buffer> {
    while (!this.pending.length && !this.done) {
      const next = await this.iterator.next();
      this.done = !!next.done;
      if (!next.done) this.pending = Buffer.from(next.value);
    }
    const bytes = this.pending.subarray(0, maximum);
    this.pending = this.pending.subarray(bytes.length);
    return bytes;
  }
  async exact(size: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let count = 0;
    while (count < size) {
      const b = await this.take(Math.min(65536, size - count));
      if (!b.length) throw Error("Truncated archive EOF");
      chunks.push(b);
      count += b.length;
    }
    return Buffer.concat(chunks, size);
  }
  prepend(bytes: Buffer) {
    this.pending = Buffer.concat([bytes, this.pending]);
  }
  async *rest() {
    for (;;) {
      const b = await this.take(65536);
      if (!b.length) return;
      yield b;
    }
  }
}
async function* decode(source: Bytes, limits: ArtifactArchiveLimits): AsyncGenerator<Buffer> {
  const magic = await source.exact(2);
  if (magic[0] !== 0x1f || magic[1] !== 0x8b) {
    source.prepend(magic);
    yield* source.rest();
    return;
  }
  const header = await source.exact(8);
  if (header[0] !== 8 || header[1]! & 0xe0) throw Error("Unsupported gzip header");
  const flags = header[1]!;
  let headerBytes = 10;
  if (flags & 4) {
    const size = (await source.exact(2)).readUInt16LE();
    headerBytes += 2 + size;
    if (headerBytes > limits.maxExtendedHeaderBytes) throw Error("gzip header limit");
    await source.exact(size);
  }
  for (const flag of [8, 16])
    if (flags & flag) {
      for (;;) {
        if (++headerBytes > limits.maxExtendedHeaderBytes) throw Error("gzip header limit");
        if ((await source.exact(1))[0] === 0) break;
      }
    }
  // Header CRC is deliberately unsupported; accepting it without checking is unsafe.
  if (flags & 2) throw Error("Unsupported gzip header CRC");
  const inflate = createInflateRaw({ chunkSize: 65536 });
  let crc = 0,
    total = 0;
  let footer: Buffer | undefined;
  const feed = (async () => {
    try {
      for (;;) {
        const chunk = await source.take(65536);
        if (!chunk.length) break;
        const before = inflate.bytesWritten;
        await new Promise<void>((resolve, reject) =>
          inflate.write(chunk, (e) => (e ? reject(e) : resolve())),
        );
        const consumed = inflate.bytesWritten - before;
        if (consumed < chunk.length) {
          source.prepend(chunk.subarray(consumed));
          break;
        }
      }
      inflate.end();
      footer = await source.exact(8);
      if ((await source.take(1)).length) throw Error("Concatenated or trailing gzip data");
    } catch (e) {
      inflate.destroy(e as Error);
      throw e;
    }
  })();
  feed.catch(() => undefined);
  try {
    for await (const raw of inflate) {
      const b = Buffer.from(raw);
      crc = crc32(b, crc);
      total = (total + b.length) >>> 0;
      yield b;
    }
    await feed;
    if (!footer || footer.readUInt32LE() !== crc || footer.readUInt32LE(4) !== total)
      throw Error("gzip checksum or size mismatch");
  } finally {
    inflate.destroy();
  }
}
function number(header: Buffer, start: number, length: number): number {
  const field = header.subarray(start, start + length);
  let value = 0;
  if (field[0]! & 0x80) {
    if (field[0] !== 0x80) throw Error("Invalid tar size");
    for (const byte of field.subarray(1)) {
      value = value * 256 + byte;
      if (!Number.isSafeInteger(value)) throw Error("Tar size exceeds safe integer");
    }
  } else {
    const text = field.toString("ascii").replace(/\0.*$/s, "").trim();
    if (!/^[0-7]*$/.test(text)) throw Error("Invalid tar numeric metadata");
    value = parseInt(text || "0", 8);
  }
  if (!Number.isSafeInteger(value) || value < 0) throw Error("Invalid tar size");
  return value;
}
function utf8(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function tarString(header: Buffer, start: number, length: number): string {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  return utf8(nul < 0 ? field : field.subarray(0, nul));
}
function pax(data: Buffer): Record<string, string> {
  const result: Record<string, string> = Object.create(null);
  let offset = 0,
    count = 0;
  while (offset < data.length) {
    const space = data.indexOf(32, offset);
    if (space < 0 || space - offset > 10) throw Error("Invalid PAX length");
    const str = data.subarray(offset, space).toString("ascii");
    if (!/^[1-9][0-9]*$/.test(str)) throw Error("Invalid PAX length");
    const length = Number(str);
    if (
      length <= space - offset + 2 ||
      offset + length > data.length ||
      data[offset + length - 1] !== 10 ||
      ++count > 256
    )
      throw Error("Invalid PAX bounds");
    const text = utf8(data.subarray(space + 1, offset + length - 1));
    const equal = text.indexOf("=");
    const key = text.slice(0, equal);
    if (equal < 1 || Object.hasOwn(result, key) || /sparse|linkpath/i.test(key))
      throw Error("Unsupported or duplicate PAX metadata");
    if (
      ![
        "path",
        "size",
        "mtime",
        "atime",
        "ctime",
        "uid",
        "gid",
        "uname",
        "gname",
        "charset",
        "comment",
        "SCHILY.fflags",
        "LIBARCHIVE.creationtime",
      ].includes(key)
    )
      throw Error("Unsupported PAX metadata");
    result[key] = text.slice(equal + 1);
    offset += length;
  }
  return result;
}
export async function validateBuildBundle(options: {
  source: Readable;
  stagingRoot: string;
  limits: ArtifactArchiveLimits;
  signal: AbortSignal;
}): Promise<ValidatedBuildBundle> {
  const { source, limits, signal } = options;
  checkLimits(limits);
  signal.throwIfAborted();
  const root = new AnchoredDirectory(options.stagingRoot);
  if (root.list().length) {
    root.close();
    throw Error("Archive staging root must be empty");
  }
  const archiveHash = createHash("sha256");
  let wireBytes = 0,
    framedBytes = 0;
  const abort = () => source.destroy(Error("Archive validation aborted"));
  signal.addEventListener("abort", abort, { once: true });
  async function* wire() {
    for await (const raw of source) {
      signal.throwIfAborted();
      const b = Buffer.from(raw);
      wireBytes += b.length;
      if (wireBytes > limits.maxUploadBytes || wireBytes > limits.maxStageBytes)
        throw Error("Archive upload limit exceeded");
      archiveHash.update(b);
      yield b;
    }
  }
  const decoded = decode(new Bytes(wire()), limits);
  async function* bounded() {
    for await (const b of decoded) {
      signal.throwIfAborted();
      framedBytes += b.length;
      if (
        framedBytes >
          limits.maxExpandedBytes +
            limits.maxManifestBytes +
            limits.maxEntries * 1024 +
            limits.maxExtendedHeaderBytes * limits.maxEntries ||
        (framedBytes > limits.expansionRatioThresholdBytes &&
          framedBytes > Math.max(1, wireBytes) * limits.maxExpansionRatio)
      )
        throw Error("Archive expanded bytes or gzip ratio limit exceeded");
      yield b;
    }
  }
  const reader = new Bytes(bounded());
  let manifest: BundleManifest | undefined,
    manifestSha256 = "",
    expandedBytes = 0,
    headers = 0;
  let extended: Record<string, string> | undefined;
  const seen = new Set<string>();
  let expectedFiles = new Map<string, BundleFile>(),
    expectedDirs = new Set<string>();
  try {
    for (;;) {
      signal.throwIfAborted();
      const header = await reader.exact(512);
      if (header.every((b) => b === 0)) {
        const end = await reader.exact(512);
        if (end.some((b) => b !== 0) || extended) throw Error("Invalid tar terminator");
        let trailingBytes = 0;
        for await (const b of reader.rest()) {
          trailingBytes += b.length;
          if (b.some((v) => v !== 0)) throw Error("Unexpected trailing tar data");
        }
        if (trailingBytes % 512 !== 0) throw Error("Truncated trailing tar block");
        break;
      }
      if (++headers > limits.maxEntries + 1) throw Error("Archive entry limit exceeded");
      let checksum = 0;
      for (let i = 0; i < 512; i++) checksum += i >= 148 && i < 156 ? 32 : header[i]!;
      if (checksum !== number(header, 148, 8)) throw Error("Invalid tar header checksum");
      const type = String.fromCharCode(header[156] || 48);
      const rawSize = number(header, 124, 12);
      if (!["0", "5", "x", "L"].includes(type))
        throw Error("Unsupported tar type (links, devices and sparse members are forbidden)");
      if (type === "x" || type === "L") {
        if (extended || rawSize > limits.maxExtendedHeaderBytes)
          throw Error("Extended tar header limit or repeated metadata");
        const bytes = await reader.exact(rawSize);
        await reader.exact((512 - (rawSize % 512)) % 512);
        extended = type === "x" ? pax(bytes) : { path: utf8(bytes).replace(/\0$/, "") };
        continue;
      }
      const prefix = tarString(header, 345, 155);
      let name = extended?.path ?? [prefix, tarString(header, 0, 100)].filter(Boolean).join("/");
      let size = rawSize;
      if (extended?.size !== undefined) {
        if (!/^(0|[1-9][0-9]*)$/.test(extended.size)) throw Error("Invalid PAX size");
        size = Number(extended.size);
        if (!Number.isSafeInteger(size)) throw Error("Invalid PAX size");
      }
      extended = undefined;
      if (type === "5") name = name.replace(/\/$/, "");
      if (!safeArtifactPath(name, limits.maxPathBytes, limits.maxPathDepth))
        throw Error("Unsafe archive member path");
      if (seen.has(name)) throw Error("Duplicate normalized archive path");
      seen.add(name);
      if (type === "5" && size !== 0) throw Error("Invalid directory size");
      if (size > limits.maxEntryBytes) throw Error("Archive entry size limit exceeded");
      if (!manifest) {
        if (type === "5" && name === ".openmapx-bundle") continue;
        if (type !== "0" || name !== BUNDLE_MANIFEST_PATH)
          throw Error("Manifest must be first regular archive member");
        if (size > limits.maxManifestBytes) throw Error("Manifest size limit exceeded");
        const bytes = await reader.exact(size);
        manifest = parseBundleManifest(utf8(bytes));
        manifestSha256 = createHash("sha256").update(bytes).digest("hex");
        if (manifest.files.length + manifest.directories.length > limits.maxEntries)
          throw Error("Manifest entry limit exceeded");
        let total = 0;
        for (const f of manifest.files) {
          total += f.sizeBytes;
          if (
            f.sizeBytes > limits.maxEntryBytes ||
            !Number.isSafeInteger(total) ||
            total > limits.maxExpandedBytes
          )
            throw Error("Manifest expanded byte limit exceeded");
        }
        for (const p of [...manifest.directories, ...manifest.files.map((f) => f.path)])
          if (!safeArtifactPath(p, limits.maxPathBytes, limits.maxPathDepth))
            throw Error("Manifest path limit exceeded");
        expectedFiles = new Map(manifest.files.map((f) => [f.path, f]));
        expectedDirs = new Set(manifest.directories);
      } else if (type === "5") {
        if (!expectedDirs.delete(name))
          throw Error(`Bundle contains entries its manifest does not list: ${name}`);
        withDirectories(root, name.split("/"), true, () => undefined);
      } else {
        const file = expectedFiles.get(name);
        if (!file) throw Error(`Bundle contains entries its manifest does not list: ${name}`);
        if (file.sizeBytes !== size) throw Error(`Bundle file failed verification: ${name} (size)`);
        const parts = name.split("/");
        const leaf = parts.pop()!;
        const dirs: AnchoredDirectory[] = [];
        let parent = root;
        let fd: number | undefined;
        try {
          for (const part of parts) {
            parent = parent.directory(part, true);
            dirs.push(parent);
          }
          fd = openSync(parent.name(leaf), C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
          const stat = fstatSync(fd, { bigint: true });
          const hash = createHash("sha256");
          let remaining = size;
          while (remaining) {
            const b = await reader.exact(Math.min(65536, remaining));
            signal.throwIfAborted();
            hash.update(b);
            let offset = 0;
            while (offset < b.length) offset += writeSync(fd, b, offset, b.length - offset);
            remaining -= b.length;
            expandedBytes += b.length;
            if (expandedBytes > limits.maxExpandedBytes)
              throw Error("Expanded byte limit exceeded");
          }
          fsyncSync(fd);
          parent.check();
          if (
            !sameInode(identity(stat), identity(lstatSync(parent.name(leaf), { bigint: true }))) ||
            fstatSync(fd).nlink !== 1 ||
            hash.digest("hex") !== file.sha256
          )
            throw Error(`Bundle file failed verification: ${name}`);
          expectedFiles.delete(name);
        } finally {
          if (fd !== undefined) closeSync(fd);
          for (const d of dirs.reverse()) d.close();
        }
      }
      const pad = await reader.exact((512 - (size % 512)) % 512);
      if (pad.some((b) => b !== 0)) throw Error("Nonzero tar member padding");
    }
    if (!manifest) throw Error("Bundle has no manifest");
    if (expectedFiles.size || expectedDirs.size) throw Error("Bundle is missing declared members");
    if (manifest.service === "motis" && manifest.schemaVersion === 2) {
      if (
        manifest.runtimeMaterialization !== "motis-target-credentials" ||
        !manifest.credentialRequirements
      )
        throw Error("MOTIS target materialization declaration required");
      const portable = withDirectories(root, ["motis", "live"], false, (d) =>
        portableMotisSourcesSchema.parse(
          JSON.parse(d.read("portable-sources.json", 1048576, false).toString("utf8")),
        ),
      );
      if (
        JSON.stringify(portable.sourceFingerprints) !==
          JSON.stringify(manifest.sourceFingerprints) ||
        JSON.stringify(portable.credentialRequirements) !==
          JSON.stringify(manifest.credentialRequirements)
      )
        throw Error("MOTIS portable source/credential metadata mismatch");
    }
    root.check();
    return {
      manifest,
      archiveSha256: archiveHash.digest("hex"),
      expandedBytes,
      manifestSha256,
      artifactFingerprint: artifactFingerprint(manifest.files),
    };
  } finally {
    signal.removeEventListener("abort", abort);
    source.destroy();
    await decoded.return(undefined);
    root.close();
  }
}
function excluded(path: string, dir: boolean, patterns: readonly string[]) {
  return patterns.some((p) =>
    p.startsWith("*")
      ? !dir && path.endsWith(p.slice(1))
      : p.endsWith("/")
        ? (dir ? `${path}/` : path).startsWith(p)
        : path === p,
  );
}
export async function writeBuildBundle(options: {
  dataRoot: string;
  serviceId: string;
  record: BuildRecord | BuildRecordV2;
  target: Writable;
  limits: ArtifactArchiveLimits;
  signal: AbortSignal;
}): Promise<ValidatedBuildBundle> {
  const { limits, signal, target } = options;
  checkLimits(limits);
  signal.throwIfAborted();
  const root = new AnchoredDirectory(options.dataRoot);
  const spec = buildArtifactSpec(options.serviceId);
  let record = options.record;
  let portableSources: ReturnType<typeof portableMotisSourcesSchema.parse> | undefined;
  if (options.serviceId === "motis") {
    try {
      const real = realpathSync(join(options.dataRoot, "motis/live"));
      const physical = relative(realpathSync(options.dataRoot), real);
      if (!safeArtifactPath(physical)) throw Error("Unsafe MOTIS alias");
      portableSources = withDirectories(root, physical.split("/"), false, (d) =>
        portableMotisSourcesSchema.parse(
          JSON.parse(d.read("portable-sources.json", 1048576, false).toString("utf8")),
        ),
      );
    } catch {
      root.close();
      throw Error(
        "MOTIS export requires retained portable source metadata; rebuild the candidate before exporting",
      );
    }
  }
  const files: BundleFile[] = [];
  const directories: string[] = [];
  const sources = new Map<string, string>();
  const fileRead = async (path: string, read: (fd: number, stat: Stats) => Promise<void>) => {
    const parts = path.split("/");
    const leaf = parts.pop()!;
    const opened: AnchoredDirectory[] = [];
    let parent = root;
    let fd: number | undefined;
    try {
      for (const part of parts) {
        parent = parent.directory(part);
        opened.push(parent);
      }
      const name = parent.name(leaf);
      fd = openSync(name, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
      const before = fstatSync(fd);
      if (!before.isFile() || before.nlink !== 1)
        throw Error("Refusing non-regular or hardlinked build artifact");
      await read(fd, before);
      const after = fstatSync(fd);
      parent.check();
      const current = lstatSync(name);
      if (
        before.dev !== current.dev ||
        before.ino !== current.ino ||
        before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs ||
        after.nlink !== 1
      )
        throw Error("Build artifact changed during export");
    } finally {
      if (fd !== undefined) closeSync(fd);
      for (const d of opened.reverse()) d.close();
    }
  };
  async function visit(rel: string, physical: string) {
    signal.throwIfAborted();
    if (!safeArtifactPath(rel, limits.maxPathBytes, limits.maxPathDepth))
      throw Error("Export path limit");
    if (
      options.serviceId === "motis" &&
      (rel.startsWith("motis-feed-proxy/") ||
        (rel.startsWith("motis/live/") &&
          !(rel === "motis/live/data" || rel.startsWith("motis/live/data/")) &&
          !/\.(osm\.pbf|gtfs\.zip|netex\.zip)$/.test(rel) &&
          rel !== "motis/live/portable-sources.json"))
    )
      return;
    const stat = lstatSync(join(options.dataRoot, physical));
    if (stat.isSymbolicLink()) throw Error(`Refusing symlink in build artifact: ${rel}`);
    if (stat.isDirectory()) {
      if (excluded(rel, true, spec.exclude)) return;
      directories.push(rel);
      const entries = withDirectories(root, physical.split("/"), false, (d) => d.list().sort());
      for (const name of entries) await visit(`${rel}/${name}`, `${physical}/${name}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1)
        throw Error(`Refusing non-regular or hardlinked build artifact: ${rel}`);
      if (excluded(rel, false, spec.exclude)) return;
      let sha256 = "";
      await fileRead(physical, async (fd, s) => {
        if (s.size > limits.maxEntryBytes) throw Error("Archive entry size limit");
        const hash = createHash("sha256");
        for await (const b of createReadStream("", {
          fd,
          autoClose: false,
          start: 0,
          end: s.size,
        })) {
          signal.throwIfAborted();
          hash.update(b);
        }
        sha256 = hash.digest("hex");
      });
      files.push({ path: rel, sizeBytes: stat.size, sha256 });
      sources.set(rel, physical);
    }
    if (files.length + directories.length > limits.maxEntries) throw Error("Archive entry limit");
  }
  try {
    for (const dir of spec.dirs) {
      const real = realpathSync(join(options.dataRoot, dir));
      const physical = relative(realpathSync(options.dataRoot), real);
      if (!safeArtifactPath(physical) || physical.startsWith("../"))
        throw Error("Artifact alias leaves trusted data root");
      if (
        physical !== dir &&
        !(
          options.serviceId === "motis" &&
          dir === "motis/live" &&
          /^motis\/slots\/[AB]$/.test(physical)
        )
      )
        throw Error("Untrusted artifact alias");
      await visit(dir, physical);
    }
    if (portableSources)
      record = {
        ...record,
        schemaVersion: 2,
        sourceFingerprints: portableSources.sourceFingerprints,
        credentialRequirements: portableSources.credentialRequirements,
        runtimeMaterialization: "motis-target-credentials",
        artifactFingerprint: artifactFingerprint(files),
      };
    const manifest = parseBundleManifest(
      JSON.stringify({
        ...record,
        ...(record.schemaVersion === 2 ? { artifactFingerprint: artifactFingerprint(files) } : {}),
        dirs: spec.dirs,
        directories,
        files,
      }),
    );
    if (manifest.service !== options.serviceId) throw Error("Build record service mismatch");
    const manifestBytes = Buffer.from(`${JSON.stringify(manifest)}\n`);
    if (manifestBytes.length > limits.maxManifestBytes) throw Error("Manifest size limit");
    const expandedBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
    if (!Number.isSafeInteger(expandedBytes) || expandedBytes > limits.maxExpandedBytes)
      throw Error("Expanded byte limit");
    const archive = pack();
    let written = 0;
    const hash = createHash("sha256");
    const output = pipeline(
      archive,
      async function* (source) {
        for await (const raw of source) {
          const b = Buffer.from(raw as Uint8Array);
          written += b.length;
          if (written > limits.maxUploadBytes) throw Error("Archive upload limit");
          hash.update(b);
          yield b;
        }
      },
      target,
      { signal },
    );
    output.catch(() => undefined);
    const entry = (name: string, body: Buffer, type: "file" | "directory" = "file") =>
      new Promise<void>((resolve, reject) => {
        archive.entry(
          {
            name,
            size: body.length,
            type,
            mode: type === "file" ? 0o600 : 0o700,
            mtime: new Date(0),
            uid: 0,
            gid: 0,
          },
          body,
          (e) => (e ? reject(e) : resolve()),
        );
      });
    try {
      await entry(BUNDLE_MANIFEST_PATH, manifestBytes);
      for (const d of directories) await entry(d, Buffer.alloc(0), "directory");
      for (const file of files)
        await fileRead(sources.get(file.path)!, async (fd, stat) => {
          if (stat.size !== file.sizeBytes) throw Error("Build artifact size changed");
          const digest = createHash("sha256");
          const member = archive.entry({
            name: file.path,
            size: file.sizeBytes,
            type: "file",
            mode: 0o600,
            mtime: new Date(0),
            uid: 0,
            gid: 0,
          });
          await pipeline(
            createReadStream("", { fd, autoClose: false, start: 0 }),
            async function* (source) {
              for await (const b of source) {
                digest.update(b);
                yield b;
              }
            },
            member,
            { signal },
          );
          if (digest.digest("hex") !== file.sha256)
            throw Error("Build artifact digest changed during export");
        });
      archive.finalize();
      await output;
    } catch (e) {
      archive.destroy(e as Error);
      await output.catch(() => undefined);
      throw e;
    }
    return {
      manifest,
      archiveSha256: hash.digest("hex"),
      expandedBytes,
      manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
      artifactFingerprint: artifactFingerprint(files),
    };
  } finally {
    root.close();
  }
}
