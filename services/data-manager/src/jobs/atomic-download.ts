import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { execa } from "execa";

export interface CurlAtomicOptions {
  /**
   * Invoked roughly every second with the current byte count of the in-flight
   * temp file and (when available from a HEAD request) the total expected
   * bytes. Used to stream progress back to the client.
   */
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void;
}

/**
 * Download `url` to `targetPath` atomically: streams to a sibling `.tmp.<rand>`
 * file, then renames into place on success. On failure (curl non-zero exit,
 * abort, etc.) the temp file is unlinked, so consumers never see a partial
 * download at the final path.
 */
export async function curlAtomic(
  url: string,
  targetPath: string,
  opts: CurlAtomicOptions = {},
): Promise<void> {
  const rand = Math.random().toString(36).slice(2, 10);
  const tmpPath = `${targetPath}.tmp.${rand}`;

  // Probe the total content length up-front so the CLI can render a real
  // percentage. Best-effort; failures are fine — the CLI will just show
  // bytes-downloaded without a total.
  let totalBytes: number | undefined;
  if (opts.onProgress) {
    try {
      const head = await execa("curl", ["-sIL", url], { timeout: 15_000 });
      const match = head.stdout.match(/^\s*content-length:\s*(\d+)/im);
      if (match?.[1]) totalBytes = Number(match[1]);
    } catch {
      // ignore — totalBytes stays undefined
    }
  }

  const child = execa("curl", ["-fSL", "-o", tmpPath, url], { stdio: "inherit" });
  const poll = opts.onProgress
    ? setInterval(() => {
        try {
          const size = statSync(tmpPath).size;
          opts.onProgress?.(size, totalBytes);
        } catch {
          // tmp file not created yet
        }
      }, 1000)
    : null;

  try {
    await child;
    if (poll) clearInterval(poll);
    // One final update so the client sees 100%.
    if (opts.onProgress) {
      try {
        opts.onProgress(statSync(tmpPath).size, totalBytes);
      } catch {
        // best effort
      }
    }
    renameSync(tmpPath, targetPath);
  } catch (err) {
    if (poll) clearInterval(poll);
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
