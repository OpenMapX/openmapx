import { readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Hashes of every task in the given Turbo run summaries. */
export function usedTaskHashes(summaries) {
  const hashes = new Set(
    summaries.flatMap((summary) => (summary.tasks ?? []).map((task) => task.hash)),
  );
  hashes.delete(undefined);
  return hashes;
}

/** Cache files (`<hash>.tar.zst`, `<hash>-meta.json`, ...) of tasks outside `used`. */
export function unusedCacheFiles(files, used) {
  return files.filter((file) => !used.has(file.split(/[.-]/)[0]));
}

if (import.meta.main) {
  const [runs, cache] = process.argv.slice(2);
  const summaries = readdirSync(runs)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(join(runs, file), "utf8")));
  const used = usedTaskHashes(summaries);
  // Without a summary every artifact would look unused; keep the cache intact.
  if (!used.size) throw new Error(`No Turbo task hashes in ${runs}`);
  const unused = unusedCacheFiles(readdirSync(cache), used);
  for (const file of unused) rmSync(join(cache, file));
  console.log(`Kept the artifacts of ${used.size} tasks; removed ${unused.length} files.`);
}
