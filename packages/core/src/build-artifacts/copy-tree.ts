/** Bounded data-only filesystem copying. No admission, signer or effect authority. */
import { createHash, randomUUID } from "node:crypto";
import {
  type BigIntStats,
  constants,
  fsyncSync,
  lstatSync,
  type ReadStream,
  renameSync,
  statfsSync,
  unlinkSync,
  type WriteStream,
} from "node:fs";
import { open } from "node:fs/promises";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { artifactFingerprint, safeArtifactPath } from "./artifact-path";
import { type AnchoredDirectory, identity, sameInode } from "./filesystem";
export interface ArtifactTreeLimits {
  maximumEntries: number;
  maximumBytes: number;
  maximumManifestBytes: number;
}
interface FileObservation {
  path: string;
  sizeBytes: number;
  dev: string;
  ino: string;
  mtimeNs: string;
  ctimeNs: string;
}
export interface ArtifactTreeInventory {
  files: FileObservation[];
  directories: string[];
  totalBytes: number;
  metadataDigest: string;
}
function checkLimits(limits: ArtifactTreeLimits) {
  if (
    !Number.isSafeInteger(limits.maximumEntries) ||
    limits.maximumEntries < 0 ||
    limits.maximumEntries > 100000 ||
    !Number.isSafeInteger(limits.maximumBytes) ||
    limits.maximumBytes < 0 ||
    !Number.isSafeInteger(limits.maximumManifestBytes) ||
    limits.maximumManifestBytes < 0 ||
    limits.maximumManifestBytes > 64 * 1024 * 1024
  )
    throw Error("Invalid artifact tree budget");
}
function observation(path: string, stat: BigIntStats): FileObservation {
  return {
    path,
    sizeBytes: Number(stat.size),
    dev: String(stat.dev),
    ino: String(stat.ino),
    mtimeNs: String(stat.mtimeNs),
    ctimeNs: String(stat.ctimeNs),
  };
}

export function inspectArtifactTree(
  source: AnchoredDirectory,
  limits: ArtifactTreeLimits,
): ArtifactTreeInventory {
  checkLimits(limits);
  source.check();
  const files: FileObservation[] = [],
    directories: string[] = [];
  let totalBytes = 0,
    manifestBytes = 128;
  const count = () => {
    if (
      files.length + directories.length > limits.maximumEntries ||
      totalBytes > limits.maximumBytes ||
      !Number.isSafeInteger(totalBytes) ||
      manifestBytes > limits.maximumManifestBytes
    )
      throw Error("Artifact tree exceeds its budget");
  };
  const scan = (directory: AnchoredDirectory, prefix: string, depth: number) => {
    if (depth > 64) throw Error("Artifact tree exceeds its depth budget");
    for (const name of directory.listBounded(limits.maximumEntries + 1).sort()) {
      const path = prefix ? `${prefix}/${name}` : name;
      if (!safeArtifactPath(path)) throw Error("Unsafe artifact path");
      const stat = lstatSync(directory.name(name), { bigint: true });
      if (stat.isSymbolicLink()) throw Error("Artifact tree contains a symlink");
      if (stat.isDirectory()) {
        directories.push(path);
        manifestBytes += Buffer.byteLength(JSON.stringify(path)) + 1;
        count();
        const child = directory.directory(name);
        try {
          scan(child, path, depth + 1);
        } finally {
          child.close();
        }
      } else if (stat.isFile()) {
        const file = observation(path, stat);
        files.push(file);
        totalBytes += file.sizeBytes;
        manifestBytes += Buffer.byteLength(JSON.stringify(file)) + 1;
        count();
      } else throw Error("Artifact tree contains a special file");
    }
    directory.check();
  };
  scan(source, "", 0);
  const metadataDigest = createHash("sha256")
    .update(JSON.stringify({ directories, files }))
    .digest("hex");
  return { files, directories, totalBytes, metadataDigest };
}
function parent(root: AnchoredDirectory, path: string, create: boolean) {
  const parts = path.split("/"),
    opened: AnchoredDirectory[] = [];
  let directory = root;
  try {
    for (const name of parts.slice(0, -1)) {
      directory = directory.directory(name, create, create ? true : undefined);
      opened.push(directory);
    }
    return {
      directory,
      name: parts.at(-1)!,
      close: () => {
        for (const dir of opened.reverse()) dir.close();
      },
    };
  } catch (error) {
    for (const dir of opened.reverse()) dir.close();
    throw error;
  }
}

/** Detach producer files before a build can rewrite inputs shared with a live generation.
 * Only the producer directory entry changes; existing consumers retain their inode/bytes.
 * Cancellation returns only after all owned writes and temporary-file cleanup settle. */
export async function isolateArtifactHardlinks(
  input: ArtifactTreeLimits & {
    source: AnchoredDirectory;
    minimumFreeBytes: number;
    signal?: AbortSignal;
  },
): Promise<{ isolated: number; canceled: boolean }> {
  if (!Number.isSafeInteger(input.minimumFreeBytes) || input.minimumFreeBytes < 0)
    throw Error("Invalid isolation capacity floor");
  const inventory = inspectArtifactTree(input.source, input);
  const shared = inventory.files.filter((file) => {
    const location = parent(input.source, file.path, false);
    try {
      const current = lstatSync(location.directory.name(location.name), { bigint: true });
      if (JSON.stringify(observation(file.path, current)) !== JSON.stringify(file))
        throw Error("Producer input changed before isolation");
      return current.nlink > 1n;
    } finally {
      location.close();
    }
  });
  const bytes = shared.reduce((sum, file) => sum + file.sizeBytes, 0);
  if (bytes > 0) {
    const capacity = statfsSync(input.source.anchor, { bigint: true });
    if (
      capacity.bavail * capacity.bsize <
      BigInt(Math.max(bytes, input.minimumFreeBytes)) + 64n * 1024n * 1024n
    )
      throw Error("Insufficient capacity to isolate shared producer inputs");
  }
  let isolated = 0;
  for (const file of shared) {
    if (input.signal?.aborted) return { isolated, canceled: true };
    const location = parent(input.source, file.path, false);
    const temporary = `.isolate-${randomUUID()}`;
    let reader: Awaited<ReturnType<typeof open>> | undefined,
      writer: Awaited<ReturnType<typeof open>> | undefined,
      created = false;
    try {
      reader = await open(
        location.directory.name(location.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await reader.stat({ bigint: true });
      if (
        !before.isFile() ||
        JSON.stringify(observation(file.path, before)) !== JSON.stringify(file)
      )
        throw Error("Producer input changed before isolation");
      writer = await open(
        location.directory.name(temporary),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        Number(before.mode & 0o755n),
      );
      created = true;
      const buffer = Buffer.alloc(1024 * 1024);
      let total = 0;
      while (total < file.sizeBytes) {
        if (input.signal?.aborted) return { isolated, canceled: true };
        const { bytesRead } = await reader.read(
          buffer,
          0,
          Math.min(buffer.length, file.sizeBytes - total),
          null,
        );
        if (!bytesRead) throw Error("Producer input truncated during isolation");
        let written = 0;
        while (written < bytesRead) {
          const result = await writer.write(buffer, written, bytesRead - written, null);
          if (!result.bytesWritten) throw Error("Producer isolation write did not advance");
          written += result.bytesWritten;
        }
        total += bytesRead;
      }
      // Detachment is not a download. Keep the producer's original data age
      // so upstream freshness/cache decisions cannot mistake it for new data.
      await writer.utimes(Number(before.atimeNs) / 1e9, Number(before.mtimeNs) / 1e9);
      await writer.sync();
      if (input.signal?.aborted) return { isolated, canceled: true };
      if (
        JSON.stringify(observation(file.path, await reader.stat({ bigint: true }))) !==
          JSON.stringify(file) ||
        JSON.stringify(
          observation(
            file.path,
            lstatSync(location.directory.name(location.name), { bigint: true }),
          ),
        ) !== JSON.stringify(file)
      )
        throw Error("Producer input changed during isolation");
      location.directory.check();
      renameSync(location.directory.name(temporary), location.directory.name(location.name));
      created = false;
      fsyncSync(location.directory.fd);
      isolated++;
    } finally {
      try {
        await reader?.close();
      } finally {
        try {
          await writer?.close();
        } finally {
          try {
            if (created) {
              unlinkSync(location.directory.name(temporary));
              fsyncSync(location.directory.fd);
            }
          } finally {
            location.close();
          }
        }
      }
    }
  }
  return { isolated, canceled: input.signal?.aborted ?? false };
}
export async function copyArtifactTree(
  input: ArtifactTreeLimits & {
    source: AnchoredDirectory;
    destination: AnchoredDirectory;
    expectedInventory: string;
    signal?: AbortSignal;
  },
) {
  const inventory = inspectArtifactTree(input.source, input);
  if (inventory.metadataDigest !== input.expectedInventory)
    throw Error("Artifact source changed before copy");
  input.destination.check();
  if (
    sameInode(identity(input.source.stat), identity(input.destination.stat)) ||
    input.destination.hasEntries()
  )
    throw Error("Empty separate artifact destination required");
  const files: Array<{ path: string; sizeBytes: number; sha256: string }> = [];
  for (const path of inventory.directories) {
    const target = parent(input.destination, path + "/.directory", true);
    target.close();
  }
  for (const file of inventory.files) {
    input.signal?.throwIfAborted();
    const source = parent(input.source, file.path, false),
      target = parent(input.destination, file.path, true);
    let reader: Awaited<ReturnType<typeof open>> | undefined,
      writer: Awaited<ReturnType<typeof open>> | undefined,
      readStream: ReadStream | undefined,
      writeStream: WriteStream | undefined;
    try {
      reader = await open(
        source.directory.name(source.name),
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      const before = await reader.stat({ bigint: true });
      if (
        !before.isFile() ||
        JSON.stringify(observation(file.path, before)) !== JSON.stringify(file)
      )
        throw Error("Artifact source inode changed");
      writer = await open(
        target.directory.name(target.name),
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      const hash = createHash("sha256");
      readStream = reader.createReadStream({ autoClose: false });
      writeStream = writer.createWriteStream({ autoClose: false });
      await pipeline(
        readStream,
        new Transform({
          transform(chunk, _encoding, done) {
            hash.update(chunk);
            done(null, chunk);
          },
        }),
        writeStream,
        { signal: input.signal },
      );
      await writer.sync();
      if (
        JSON.stringify(observation(file.path, await reader.stat({ bigint: true }))) !==
        JSON.stringify(file)
      )
        throw Error("Artifact source changed during copy");
      source.directory.check();
      target.directory.check();
      fsyncSync(target.directory.fd);
      files.push({ path: file.path, sizeBytes: file.sizeBytes, sha256: hash.digest("hex") });
    } finally {
      readStream?.destroy();
      writeStream?.destroy();
      try {
        await reader?.close();
      } finally {
        try {
          await writer?.close();
        } finally {
          source.close();
          target.close();
        }
      }
    }
  }
  if (inspectArtifactTree(input.source, input).metadataDigest !== input.expectedInventory)
    throw Error("Artifact source changed during copy");
  fsyncSync(input.destination.fd);
  return {
    files,
    directories: inventory.directories,
    totalBytes: inventory.totalBytes,
    fingerprint: artifactFingerprint(files),
  };
}
/** Hash a regular artifact through a stable descriptor with bounded, abortable reads. */
export async function hashArtifactFile(
  root: AnchoredDirectory,
  path: string,
  signal?: AbortSignal,
) {
  if (!safeArtifactPath(path)) throw Error("Unsafe artifact path");
  const source = parent(root, path, false);
  let reader: Awaited<ReturnType<typeof open>> | undefined;
  try {
    signal?.throwIfAborted();
    reader = await open(
      source.directory.name(source.name),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    const before = await reader.stat({ bigint: true });
    if (!before.isFile() || before.size > BigInt(Number.MAX_SAFE_INTEGER))
      throw Error("Regular bounded artifact required");
    const hash = createHash("sha256"),
      buffer = Buffer.alloc(1024 * 1024);
    let total = 0;
    for (;;) {
      signal?.throwIfAborted();
      const { bytesRead } = await reader.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      total += bytesRead;
      if (BigInt(total) > before.size) throw Error("Artifact grew while hashing");
      hash.update(buffer.subarray(0, bytesRead));
    }
    if (
      BigInt(total) !== before.size ||
      JSON.stringify(observation(path, before)) !==
        JSON.stringify(observation(path, await reader.stat({ bigint: true })))
    )
      throw Error("Artifact changed while hashing");
    source.directory.check();
    return { path, sizeBytes: total, sha256: hash.digest("hex") };
  } finally {
    await reader?.close();
    source.close();
  }
}
