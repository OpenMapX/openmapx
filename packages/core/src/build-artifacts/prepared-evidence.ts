/** Local output identity binding; portable build records never contain host identities. */
import { lstatSync, realpathSync } from "node:fs";
import { join, relative } from "node:path";
import { z } from "zod";
import {
  dataFileIdentitySchema,
  hashDataFile,
  inspectDataFile,
  sameDataFile,
  withDataDirectory,
  withDataDirectoryAsync,
} from "./data-evidence";
import {
  artifactFingerprint,
  BUILD_RECORD_DIR,
  type BuildRecord,
  type BuildRecordV2,
  type BundleFile,
  buildArtifactSpec,
  buildRecordSchema,
  safeArtifactPath,
} from "./manifest";

const fileSchema = z.strictObject({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  ...dataFileIdentitySchema.shape,
});
export const preparedBuildEvidenceSchema = z.strictObject({
  schemaVersion: z.literal(1),
  record: buildRecordSchema,
  files: z.array(fileSchema).max(10000),
  inputs: z.array(fileSchema).max(10000).default([]),
});
export const PREPARED_EVIDENCE_BYTES = 16 * 1024 * 1024;
export function preparedArtifactPath(dataRoot: string, path: string): string {
  if (!safeArtifactPath(path)) throw Error("Invalid prepared path");
  // The sole existing managed alias is MOTIS' fixed A/B slot selector.
  if (path === "motis/live" || path.startsWith("motis/live/")) {
    const real = relative(realpathSync(dataRoot), realpathSync(join(dataRoot, "motis/live")));
    if (real !== "motis/live" && !/^motis\/slots\/[AB]$/.test(real))
      throw Error("Untrusted MOTIS artifact alias");
    return real + path.slice("motis/live".length);
  }
  return path;
}
function excluded(path: string, dir: boolean, patterns: readonly string[]) {
  return patterns.some((pattern) =>
    pattern.startsWith("*.")
      ? path.endsWith(pattern.slice(1))
      : pattern.endsWith("/")
        ? (dir ? path + "/" : path).startsWith(pattern)
        : path === pattern,
  );
}
export function incompletePreparedLayout(
  service: string,
  files: readonly { path: string; sizeBytes: number }[],
): string | null {
  const has = (p: string) => files.some((file) => file.path === p && file.sizeBytes > 0);
  if (
    service === "osrm" &&
    !["region.osrm", "region.osrm.partition", "region.osrm.cells", "region.osrm.mldgr"].every((n) =>
      has(`osrm-graph/${n}`),
    )
  )
    return "The OSRM graph or required MLD companions are missing.";
  if (service === "otp" && !has("otp-graph/graph.obj"))
    return "The OTP graph.obj output is missing.";
  if (service === "tileserver" && !has("tile-mbtiles/tiles.mbtiles"))
    return "The tile MBTiles output is missing.";
  if (
    service === "motis" &&
    (!has("motis/live/motis-candidate-manifest.json") ||
      !files.some((file) => file.path.startsWith("motis/live/data/") && file.sizeBytes > 0))
  )
    return "A verified MOTIS manifest and imported data output are required.";
  return files.some((file) => file.sizeBytes > 0) ? null : "Prepared output files are missing.";
}
export async function capturePreparedBuildEvidence(options: {
  dataRoot: string;
  record: BuildRecord | BuildRecordV2;
  signal?: AbortSignal;
  verifiedFiles?: readonly BundleFile[];
  inputs?: z.infer<typeof fileSchema>[];
}): Promise<BuildRecordV2> {
  const { dataRoot, signal } = options,
    spec = buildArtifactSpec(options.record.service),
    files: z.infer<typeof fileSchema>[] = [],
    known = new Map(options.verifiedFiles?.map((f) => [f.path, f]));
  let entries = 0;
  async function visit(path: string) {
    signal?.throwIfAborted();
    if (++entries > 10000) throw Error("Prepared metadata capacity exceeded");
    const physical = preparedArtifactPath(dataRoot, path),
      stat = withDataDirectory(dataRoot, physical.split("/").slice(0, -1).join("/"), (dir) =>
        lstatSync(dir.name(physical.split("/").at(-1) ?? "")),
      );
    if (stat.isSymbolicLink()) throw Error("Prepared artifact symlink refused");
    if (stat.isDirectory()) {
      if (excluded(path, true, spec.exclude)) return;
      const names = withDataDirectory(dataRoot, physical, (dir) => dir.listBounded(10000));
      for (const name of names) await visit(`${path}/${name}`);
    } else {
      if (excluded(path, false, spec.exclude)) return;
      const metadata = inspectDataFile(dataRoot, physical),
        previous = known.get(path);
      if (previous && previous.sizeBytes !== metadata.sizeBytes)
        throw Error("Imported output size changed before recording");
      const sha256 =
        previous?.sha256 ??
        (await withDataDirectoryAsync(dataRoot, physical.split("/").slice(0, -1).join("/"), (dir) =>
          hashDataFile(dir.name(physical.split("/").at(-1) ?? ""), signal),
        ));
      const hash = typeof sha256 === "string" ? sha256 : sha256.sha256;
      const after = inspectDataFile(dataRoot, physical);
      if (
        !sameDataFile(metadata, after) ||
        (typeof sha256 !== "string" &&
          !sameDataFile(after, {
            device: sha256.device,
            inode: sha256.inode,
            sizeBytes: sha256.sizeBytes,
            modifiedAtMs: sha256.modifiedAtMs,
            changedAtMs: sha256.changedAtMs,
          }))
      )
        throw Error("Prepared output changed before evidence publication");
      files.push({ path, sha256: hash, ...after });
      if (files.length > 10000) throw Error("Prepared evidence capacity exceeded");
    }
  }
  for (const dir of spec.dirs) await visit(dir);
  const sourceFingerprints =
    options.record.schemaVersion === 2 ? options.record.sourceFingerprints : [];
  const record = buildRecordSchema.parse({
    ...options.record,
    schemaVersion: 2,
    sourceFingerprints,
    artifactFingerprint: artifactFingerprint(files),
  }) as BuildRecordV2;
  const evidence = preparedBuildEvidenceSchema.parse({
    schemaVersion: 1,
    record,
    files,
    inputs: options.inputs ?? [],
  });
  const bytes = JSON.stringify(evidence);
  if (Buffer.byteLength(bytes) > PREPARED_EVIDENCE_BYTES)
    throw Error("Prepared evidence metadata capacity exceeded");
  withDataDirectory(dataRoot, "", (root) => {
    const records = root.directory(BUILD_RECORD_DIR, true);
    try {
      records.write(`${record.service}.evidence.json`, bytes);
    } finally {
      records.close();
    }
  });
  return record;
}

const motisArtifact = z.object({
  path: z.string().min(1).max(4096),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  sizeBytes: z.number().nonnegative().safe(),
});
const motisManifest = z.object({
  schemaVersion: z.literal(1),
  epoch: z.string().min(1).max(512),
  artifacts: z.object({
    config: motisArtifact,
    license: motisArtifact,
    proxyConfig: motisArtifact,
    proxyVars: motisArtifact,
    sourceManifest: motisArtifact,
    sourceIndex: motisArtifact.optional(),
    datasets: z.array(motisArtifact).min(1).max(10000),
  }),
});
/** Match the existing candidate's own hashed artifact inventory, not its filename alone. */
export function verifyPreparedMotisManifest(value: unknown, files: readonly BundleFile[]): boolean {
  const parsed = motisManifest.safeParse(value);
  if (!parsed.success) return false;
  const { datasets, sourceIndex, ...required } = parsed.data.artifacts;
  return [...Object.values(required), ...datasets, ...(sourceIndex ? [sourceIndex] : [])].every(
    (artifact) =>
      safeArtifactPath(artifact.path) &&
      files.some(
        (file) =>
          file.path === `motis/live/${artifact.path}` &&
          file.sizeBytes === artifact.sizeBytes &&
          file.sha256 === artifact.sha256,
      ),
  );
}
