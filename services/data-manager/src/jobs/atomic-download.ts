import { existsSync, renameSync, unlinkSync } from "node:fs";
import { execa } from "execa";

/**
 * Download `url` to `targetPath` atomically: streams to a sibling `.tmp.<rand>`
 * file, then renames into place on success. On failure (curl non-zero exit,
 * abort, etc.) the temp file is unlinked, so consumers never see a partial
 * download at the final path.
 */
export async function curlAtomic(url: string, targetPath: string): Promise<void> {
  const rand = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${targetPath}.tmp.${rand}`;
  try {
    await execa("curl", ["-fSL", "-o", tmpPath, url], { stdio: "inherit" });
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (existsSync(tmpPath)) {
      try {
        unlinkSync(tmpPath);
      } catch {
        // best effort
      }
    }
    throw err;
  }
}
