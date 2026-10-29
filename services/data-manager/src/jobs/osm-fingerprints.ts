/** Called only by the downloader, inside its snapshot publication lock. */

import { lstatSync } from "node:fs";
import { basename, dirname } from "node:path";
import {
  type DataFileIdentity,
  fileIdentity,
  osmArtifactId,
  osmSourceEvidenceSchema,
} from "@openmapx/core/build-artifacts";
import { AnchoredDirectory } from "../../../../packages/core/src/build-artifacts/filesystem";
export function publishOsmFingerprint(
  path: string,
  region: string,
  sha256: string,
  source: DataFileIdentity,
  renamed = false,
) {
  const directory = new AnchoredDirectory(dirname(path), undefined, false, true);
  try {
    const stat = lstatSync(directory.name(basename(path)), { bigint: true });
    if (!stat.isFile()) throw Error("Published OSM file required");
    const current = fileIdentity(stat);
    for (const key of [
      "device",
      "inode",
      "sizeBytes",
      "modifiedAtMs",
      ...(renamed ? [] : ["changedAtMs"]),
    ] as (keyof DataFileIdentity)[])
      if (source[key] !== current[key])
        throw Error("OSM source changed before evidence publication");
    const evidence = osmSourceEvidenceSchema.parse({
      schemaVersion: 1,
      artifactId: osmArtifactId(basename(path)),
      region,
      sha256,
      ...fileIdentity(stat),
    });
    directory.write(`${basename(path)}.openmapx.json`, JSON.stringify(evidence));
  } finally {
    directory.close();
  }
}
