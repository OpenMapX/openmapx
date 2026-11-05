import {
  inspectDataFile,
  osmArtifactId,
  osmSourceEvidenceSchema,
  sameDataFile,
  withDataDirectory,
} from "@openmapx/core/build-artifacts";
import type { OpsResultFor } from "@openmapx/core/ops";

type Inventory = OpsResultFor<"data.inspect">["osm"];
export function inspectOsmInventory(
  dataRoot: string,
  options: { osmLimit?: number; osmOffset?: number } = {},
): Inventory {
  const limit = options.osmLimit ?? 50,
    offset = options.osmOffset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 500 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 1000000
  )
    throw Error("Invalid OSM inventory page");
  const empty = (unavailable: boolean): Inventory => ({
    items: [],
    total: 0,
    limit,
    offset,
    unavailable,
  });
  let enumerating = false;
  const read = (location: string): Inventory =>
    withDataDirectory(dataRoot, location, (directory) => {
      enumerating = true;
      const files = directory
        .listBounded(10000)
        .filter((name) => name.length <= 255 && name.endsWith(".osm.pbf"))
        .sort();
      const items = files.slice(offset, offset + limit).map((filename) => {
        const metadata = inspectDataFile(dataRoot, location ? `${location}/${filename}` : filename);
        let fingerprintState: "verified" | "missing" | "stale" = "missing",
          sourceFingerprint: string | null = null,
          region: string | null = null;
        let bytes: Buffer | undefined;
        try {
          if (Buffer.byteLength(`${filename}.openmapx.json`) <= 255)
            bytes = directory.read(`${filename}.openmapx.json`, 16384, false);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          if (!bytes)
            return {
              artifactId: osmArtifactId(filename),
              filename,
              region,
              sizeBytes: metadata.sizeBytes,
              modifiedAt: new Date(metadata.modifiedAtMs).toISOString(),
              sourceFingerprint,
              fingerprintState,
            };
          const evidence = osmSourceEvidenceSchema.parse(JSON.parse(bytes.toString("utf8")));
          fingerprintState = "stale";
          if (
            evidence.artifactId === osmArtifactId(filename) &&
            filename === `${evidence.region.replaceAll("/", "-")}.osm.pbf` &&
            sameDataFile(metadata, {
              device: evidence.device,
              inode: evidence.inode,
              sizeBytes: evidence.sizeBytes,
              modifiedAtMs: evidence.modifiedAtMs,
              changedAtMs: evidence.changedAtMs,
            })
          ) {
            fingerprintState = "verified";
            sourceFingerprint = evidence.sha256;
            region = evidence.region;
          }
        } catch (error) {
          fingerprintState = "stale";
        }
        return {
          artifactId: osmArtifactId(filename),
          filename,
          region,
          sizeBytes: metadata.sizeBytes,
          modifiedAt: new Date(metadata.modifiedAtMs).toISOString(),
          sourceFingerprint,
          fingerprintState,
        };
      });
      directory.check();
      return { items, total: files.length, limit, offset, unavailable: false };
    });
  try {
    return read("osm");
  } catch (error) {
    if (!enumerating && (error as NodeJS.ErrnoException).code === "ENOENT") {
      try {
        return read("");
      } catch (fallback) {
        return empty(enumerating || (fallback as NodeJS.ErrnoException).code !== "ENOENT");
      }
    }
    return empty(true);
  }
}
