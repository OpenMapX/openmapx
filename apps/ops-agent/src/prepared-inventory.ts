import {
  artifactFingerprint,
  BUILD_RECORD_DIR,
  buildArtifactSpec,
  buildRecordSchema,
  incompletePreparedLayout,
  inspectDataFile,
  osmArtifactId,
  PREPARED_EVIDENCE_BYTES,
  preparedArtifactPath,
  preparedBuildEvidenceSchema,
  sameDataFile,
  verifyPreparedMotisManifest,
  withDataDirectory,
} from "@openmapx/core/build-artifacts";
import type { OpsResultFor } from "@openmapx/core/ops";
import { inspectOsmInventory } from "./osm-inventory";

type Build = OpsResultFor<"data.inspect">["builds"][number];
const targets = {
  valhalla: ["valhalla", null],
  osrm: ["osrm-graph", "osrm"],
  otp: ["otp-graph", "otp"],
  motis: ["motis/live", "motis"],
  motisFeedProxy: ["motis-feed-proxy", null],
  tiles: ["tile-mbtiles", "tileserver"],
  pelias: ["pelias", "pelias"],
  nominatim: ["nominatim", null],
  photon: ["photon", null],
  overpass: ["overpass", null],
} as const;
function readRecord(dataRoot: string, name: string, max = 16384) {
  return withDataDirectory(dataRoot, BUILD_RECORD_DIR, (dir) =>
    JSON.parse(dir.read(name, max, false).toString("utf8")),
  );
}
export function inspectPreparedInventory(
  dataRoot: string,
  osm: OpsResultFor<"data.inspect">["osm"],
): Build[] {
  return Object.entries(targets).map(([target, [path, service]]) => {
    const row: Build = {
      target: target as Build["target"],
      built: false,
      readiness: "missing",
      reason: "No prepared output directory.",
      sizeBytes: null,
      sourceFingerprints: [],
      buildRecordVersion: null,
      region: null,
      runtimeImages: {},
    };
    if (
      !service ||
      ["pelias", "nominatim", "photon", "overpass", "valhalla", "motisFeedProxy"].includes(target)
    ) {
      row.readiness = "unknown";
      row.reason =
        target === "valhalla"
          ? "Valhalla is maintained by its runtime; dataset metadata alone does not verify routing readiness."
          : "Authoritative runtime or database readiness evidence is required.";
      return row;
    }
    try {
      const physical = preparedArtifactPath(dataRoot, path);
      withDataDirectory(dataRoot, physical, (dir) => dir.check());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        row.readiness = "unknown";
        row.reason = "Prepared output could not be inspected safely.";
      }
      return row;
    }
    row.readiness = "incomplete";
    row.reason = "Prepared output has no verified build evidence.";
    try {
      const record = buildRecordSchema.parse(readRecord(dataRoot, `${service}.json`));
      if (record.service !== service) throw Error("Build service mismatch");
      row.buildRecordVersion = record.schemaVersion;
      if (
        (record.region?.length ?? 0) > 2048 ||
        Object.values(record.runtimeImages).some((image) => image.length > 2048) ||
        (record.schemaVersion === 2 &&
          record.sourceFingerprints.some((source) => source.id.length > 2048))
      ) {
        row.readiness = "unknown";
        row.reason = "Build metadata exceeds the supported status field limits.";
        return row;
      }
      row.region = record.region ?? null;
      row.runtimeImages = record.runtimeImages;
      row.builtAt = record.builtAt;
      if (record.schemaVersion === 1) {
        row.readiness = "unknown";
        row.reason =
          "Legacy build record has no source fingerprints; rebuild or import verified data.";
        return row;
      }
      row.sourceFingerprints = record.sourceFingerprints.map(({ id, sha256 }) => ({ id, sha256 }));
      if (
        record.schemaVersion === 2 &&
        new Set(record.sourceFingerprints.map((source) => source.id)).size !==
          record.sourceFingerprints.length
      )
        throw Error("Duplicate source fingerprint identity");
      const evidence = preparedBuildEvidenceSchema.parse(
        readRecord(dataRoot, `${service}.evidence.json`, PREPARED_EVIDENCE_BYTES),
      );
      if (new Set(evidence.files.map((file) => file.path)).size !== evidence.files.length)
        throw Error("Duplicate recorded output path");
      if (
        JSON.stringify(evidence.record) !== JSON.stringify(record) ||
        record.artifactFingerprint !== artifactFingerprint(evidence.files)
      )
        throw Error("Build evidence mismatch");
      if (service === "motis") {
        const valid = withDataDirectory(
          dataRoot,
          preparedArtifactPath(dataRoot, "motis/live"),
          (dir) =>
            verifyPreparedMotisManifest(
              JSON.parse(
                dir.read("motis-candidate-manifest.json", 1024 * 1024, false).toString("utf8"),
              ),
              evidence.files,
            ),
        );
        if (!valid) {
          row.reason = "MOTIS candidate manifest does not match recorded artifacts.";
          return row;
        }
      }
      const missing = incompletePreparedLayout(service, evidence.files);
      if (missing) {
        row.reason = missing;
        return row;
      }
      const layout = buildArtifactSpec(service);
      if (
        evidence.files.some(
          (file) => !layout.dirs.some((dir) => file.path.startsWith(dir + "/")),
        ) ||
        evidence.inputs.some(
          (file) =>
            file.path !== `osm/${record.sourcePbf?.name}` ||
            !record.sourceFingerprints.some(
              (source) =>
                source.id === osmArtifactId(record.sourcePbf?.name ?? "") &&
                source.sha256 === file.sha256,
            ),
        )
      )
        throw Error("Unexpected prepared evidence layout");
      for (const file of evidence.files) {
        const now = inspectDataFile(dataRoot, preparedArtifactPath(dataRoot, file.path));
        if (
          !sameDataFile(now, {
            device: file.device,
            inode: file.inode,
            sizeBytes: file.sizeBytes,
            modifiedAtMs: file.modifiedAtMs,
            changedAtMs: file.changedAtMs,
          })
        ) {
          row.readiness = "stale";
          row.reason = "Prepared output or its source changed since the build or import.";
          return row;
        }
      }
      for (const input of evidence.inputs) {
        try {
          if (
            !sameDataFile(inspectDataFile(dataRoot, input.path), {
              device: input.device,
              inode: input.inode,
              sizeBytes: input.sizeBytes,
              modifiedAtMs: input.modifiedAtMs,
              changedAtMs: input.changedAtMs,
            })
          ) {
            row.readiness = "stale";
            row.reason = "The source extract changed since this build.";
            return row;
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      row.sizeBytes = evidence.files.reduce((sum, file) => sum + file.sizeBytes, 0);
      if (!Number.isSafeInteger(row.sizeBytes))
        throw Error("Prepared size exceeds supported inventory");
      if (!record.sourceFingerprints.length || !Object.keys(record.runtimeImages).length) {
        row.readiness = "unknown";
        row.reason = "Source fingerprints and runtime image bindings are required.";
        return row;
      }
      let local = osm;
      if (record.sourcePbf && !osm.items.some((item) => item.filename === record.sourcePbf?.name)) {
        try {
          const index = withDataDirectory(dataRoot, "osm", (directory) =>
            directory
              .listBounded(10000)
              .filter((name) => name.endsWith(".osm.pbf"))
              .sort()
              .indexOf(record.sourcePbf?.name ?? ""),
          );
          if (index >= 0) local = inspectOsmInventory(dataRoot, { osmLimit: 1, osmOffset: index });
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      if (local.unavailable) {
        row.readiness = "unknown";
        row.reason = "The source inventory is unavailable.";
        return row;
      }
      for (const source of record.sourceFingerprints) {
        const current = local.items.find((item) => item.artifactId === source.id);
        if (
          current &&
          current.fingerprintState === "verified" &&
          current.sourceFingerprint !== source.sha256
        ) {
          row.readiness = "stale";
          row.reason = "The source extract has changed since this build.";
          return row;
        }
        if (current && current.fingerprintState !== "verified" && !evidence.inputs.length) {
          row.readiness = current.fingerprintState === "stale" ? "stale" : "unknown";
          row.reason = "Current source evidence is missing or stale.";
          return row;
        }
      }
      row.readiness = "ready";
      row.reason = null;
      row.built = true;
      return row;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        row.readiness = "unknown";
        row.reason = "Build metadata or output could not be verified safely.";
      }
      return row;
    }
  });
}
