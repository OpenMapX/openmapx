import { randomUUID } from "node:crypto";
import { rmSync, statfsSync } from "node:fs";
import { join } from "node:path";

/** Planet exports must not keep every node location in the Node/container heap.
 * dense_file_array is osmium's recommended planet index; area assembly still
 * needs operator-sized RAM, and the mapped index needs the data-volume budget.
 */
export async function withOsmiumLocationIndex<T>(
  region: string,
  directory: string,
  operation: (args: string[]) => Promise<T>,
): Promise<T> {
  if (region !== "planet") return operation([]);
  const required = Number(process.env.OSMIUM_PLANET_INDEX_ESTIMATE_BYTES ?? 128 * 1024 ** 3);
  if (!Number.isSafeInteger(required) || required <= 0)
    throw new Error("OSMIUM_PLANET_INDEX_ESTIMATE_BYTES must be a positive integer");
  const fs = statfsSync(directory);
  if (fs.bavail * fs.bsize < required + 5 * 1024 ** 3)
    throw new Error("Insufficient disk for the planet osmium node index and safety reserve");
  const path = join(directory, `planet-locations-${randomUUID()}.dat`);
  try {
    return await operation([`--index-type=dense_file_array,${path}`]);
  } finally {
    rmSync(path, { force: true });
  }
}
