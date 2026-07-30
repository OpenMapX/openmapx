import { existsSync, renameSync, statSync, unlinkSync } from "node:fs";
import { execa } from "execa";

export interface CurlAtomicOptions {
  /**
   * Invoked roughly every second with the current byte count of the in-flight
   * temp file and (when available from a HEAD request) the total expected
   * bytes. Used to stream progress back to the client.
   */
  onProgress?: (bytesDownloaded: number, totalBytes?: number) => void;
  /** Validate the completed sibling temp file before it can replace the target. */
  beforePublish?: (tempPath: string) => Promise<void>;
  /**
   * Optional narrow critical section around the final rename. The callback
   * must invoke `publish` exactly once before resolving.
   */
  withPublishLock?: (publish: () => void) => Promise<void>;
}

export interface CurlAtomicResult {
  published: boolean;
}

/**
 * Download `url` to `targetPath` atomically: streams to a sibling `.tmp.<rand>`
 * file, then renames into place on success. On failure (curl non-zero exit,
 * abort, etc.) the temp file is unlinked, so consumers never see a partial
 * download at the final path.
 *
 * When `targetPath` already exists, sends `If-Modified-Since: <mtime>` so
 * upstream servers (e.g. Geofabrik) can short-circuit unchanged downloads
 * with 304. On 304, the existing file is left in place and we return early.
 */
export async function curlAtomicWithResult(
  url: string,
  targetPath: string,
  opts: CurlAtomicOptions = {},
): Promise<CurlAtomicResult> {
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

  // Skip the download entirely if the upstream resource hasn't changed since
  // we last fetched it. `curl -z <file>` adds an `If-Modified-Since` header
  // matching the file's mtime; combined with `-f --fail-with-body` curl exits
  // 0 with no output on 304. Best-effort: any HEAD/GET failure falls through
  // to a normal full download below.
  const args = ["-fSL", "-o", tmpPath];
  if (existsSync(targetPath)) {
    args.push("-z", targetPath);
  }
  args.push(url);

  const child = execa("curl", args, { stdio: "inherit" });
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
    // 304 Not Modified: curl writes nothing to the tmp path. Leave the
    // existing target in place and return without renaming.
    if (!existsSync(tmpPath) || statSync(tmpPath).size === 0) {
      if (existsSync(tmpPath)) {
        try {
          unlinkSync(tmpPath);
        } catch {
          // best effort
        }
      }
      if (existsSync(targetPath) && opts.onProgress) {
        const size = statSync(targetPath).size;
        opts.onProgress(size, size);
      }
      return { published: false };
    }
    // One final update so the client sees 100%.
    if (opts.onProgress) {
      try {
        opts.onProgress(statSync(tmpPath).size, totalBytes);
      } catch {
        // best effort
      }
    }
    await opts.beforePublish?.(tmpPath);
    let published = false;
    const publish = (): void => {
      if (published) throw new Error("Atomic download publish callback invoked more than once");
      renameSync(tmpPath, targetPath);
      published = true;
    };
    if (opts.withPublishLock) {
      await opts.withPublishLock(publish);
      if (!published) {
        throw new Error("Atomic download publish lock resolved without publishing the temp file");
      }
    } else {
      publish();
    }
    return { published: true };
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

/** Backward-compatible convenience for callers that do not need publish status. */
export async function curlAtomic(
  url: string,
  targetPath: string,
  opts: CurlAtomicOptions = {},
): Promise<void> {
  await curlAtomicWithResult(url, targetPath, opts);
}
