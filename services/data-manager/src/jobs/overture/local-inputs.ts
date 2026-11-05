/** Bounded local producer metadata. Polling never hashes/parses the parquet body. */
import { closeSync, constants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { regionSchema } from "@openmapx/core/data-manager-contracts";
import { AnchoredDirectory } from "../../../../../packages/core/src/build-artifacts/filesystem";
import { assertValidOvertureRelease, validateOverturePullContract } from "./stac.js";

function availableFile(directory: AnchoredDirectory, name: string): boolean {
  let fd: number | undefined;
  try {
    fd = openSync(directory.name(name), constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    return stat.isFile() && stat.size > 0;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}
export function inspectOvertureLocalInputs(dataDir: string, selectedRegion: string) {
  const region = regionSchema.parse(selectedRegion),
    slug = region.replaceAll("/", "-"),
    root = new AnchoredDirectory(realpathSync(dataDir), undefined, false, true);
  const opened: AnchoredDirectory[] = [root];
  try {
    let osmAvailable = false,
      downloadedRelease: string | null = null,
      metadataBytes = 0;
    try {
      const osm = new AnchoredDirectory(root.name("osm"), root, false, true);
      opened.push(osm);
      osmAvailable = availableFile(osm, `${slug}.osm.pbf`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    try {
      const directory = new AnchoredDirectory(root.name("overture"), root, false, true);
      opened.push(directory);
      const releases = directory
        .listBounded(512)
        .filter((name) => {
          try {
            assertValidOvertureRelease(name);
            return true;
          } catch {
            return false;
          }
        })
        .sort((a, b) => b.localeCompare(a, "en", { numeric: true }));
      for (const release of releases) {
        const snapshot = new AnchoredDirectory(directory.name(release), directory, false, true);
        let fd: number | undefined;
        try {
          const filename = `${slug}.parquet`;
          if (!availableFile(snapshot, filename)) continue;
          fd = openSync(snapshot.name(filename), constants.O_RDONLY | constants.O_NOFOLLOW);
          const before = fstatSync(fd, { bigint: true });
          const bytes = snapshot.read(`${slug}.contract.json`, 16 * 1024 * 1024, false);
          metadataBytes += bytes.length;
          if (metadataBytes > 64 * 1024 * 1024)
            throw Object.assign(Error("Overture inspection metadata budget exceeded"), {
              code: "E2BIG",
            });
          const contract = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
          validateOverturePullContract(contract, dataDir, release, region);
          const after = fstatSync(fd, { bigint: true }),
            named = lstatSync(snapshot.name(filename), { bigint: true });
          snapshot.check();
          if (
            before.dev !== named.dev ||
            before.ino !== named.ino ||
            before.size !== after.size ||
            before.mtimeNs !== after.mtimeNs ||
            before.ctimeNs !== after.ctimeNs
          )
            throw Error("Overture partition changed during inspection");
          downloadedRelease = release;
          break;
        } catch (error) {
          // Incomplete/malformed pulls cannot enable ingest. No content is exposed.
          const code = (error as NodeJS.ErrnoException).code;
          if (code && code !== "ENOENT") throw error;
        } finally {
          if (fd !== undefined) closeSync(fd);
          snapshot.close();
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    return { osmAvailable, downloadedRelease };
  } finally {
    for (const directory of opened.reverse()) directory.close();
  }
}
