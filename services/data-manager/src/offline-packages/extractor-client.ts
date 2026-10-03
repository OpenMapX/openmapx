import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import type { OfflinePackageExtractionMetadata, OfflinePackageExtractorOptions } from "./types.js";

type ExtractionResponse =
  | { type: "result"; result: OfflinePackageExtractionMetadata }
  | { type: "error"; error: { name: string; message: string; code?: string } };

/** The generator's admission scheduler bounds parallel threads; no second queue. */
export function createOfflinePackageExtractor(options: { workerUrl?: URL } = {}) {
  const active = new Map<Worker, Promise<void>>();
  let closed = false;
  let closing: Promise<void> | undefined;
  return {
    extract(input: OfflinePackageExtractorOptions): Promise<OfflinePackageExtractionMetadata> {
      if (closed) return Promise.reject(new Error("Offline package extractor closed"));
      const entry =
        options.workerUrl ??
        new URL(
          import.meta.url.endsWith(".ts") ? "./extractor-worker.ts" : "./extractor-worker.js",
          import.meta.url,
        );
      let worker: Worker;
      let temporaryDirectory: string | undefined;
      let archivePath: string;
      try {
        mkdirSync(dirname(input.destinationPath), { recursive: true });
        if (existsSync(input.destinationPath))
          throw new Error(`PMTiles destination already exists: ${input.destinationPath}`);
        // All CLI spool/part siblings live under this parent's private owner.
        temporaryDirectory = mkdtempSync(
          join(dirname(input.destinationPath), `${basename(input.destinationPath)}.worker-`),
        );
        archivePath = join(temporaryDirectory, "archive.pmtiles");
        worker = new Worker(entry, {
          workerData: { ...input, destinationPath: archivePath },
          execArgv: [
            "--import",
            pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href,
          ],
        });
      } catch (error) {
        if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
        return Promise.reject(error);
      }
      const ownedDirectory = temporaryDirectory;
      const result = new Promise<OfflinePackageExtractionMetadata>((resolve, reject) => {
        let response: ExtractionResponse | undefined;
        let failure: Error | undefined;
        worker.on("message", (message: ExtractionResponse) => {
          response = message;
        });
        worker.on("error", (error) => {
          failure = error instanceof Error ? error : new Error(String(error));
        });
        worker.on("exit", (code) => {
          // A forced exit skips the CLI's finally block. Only after exit can
          // this parent safely remove every spool/part file owned by the job.
          let metadata: OfflinePackageExtractionMetadata | undefined;
          try {
            if (failure) throw failure;
            if (code !== 0) throw new Error(`Offline extraction worker exited (${code})`);
            if (!response) throw new Error("Offline extraction worker exited without a result");
            if (response.type === "error")
              throw Object.assign(new Error(response.error.message), response.error);
            if (existsSync(input.destinationPath))
              throw new Error(`PMTiles destination already exists: ${input.destinationPath}`);
            renameSync(archivePath, input.destinationPath);
            metadata = response.result;
          } catch (error) {
            failure = error instanceof Error ? error : new Error(String(error));
          }
          try {
            rmSync(ownedDirectory, { recursive: true, force: true });
          } catch (error) {
            failure ??= error instanceof Error ? error : new Error(String(error));
          }
          active.delete(worker);
          if (failure) reject(failure);
          else if (metadata) resolve(metadata);
          else reject(new Error("Offline extraction worker returned no metadata"));
        });
      });
      active.set(
        worker,
        result.then(
          () => undefined,
          () => undefined,
        ),
      );
      return result;
    },
    close(): Promise<void> {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        const entries = [...active.entries()];
        await Promise.all(
          entries.map(async ([worker, settled]) => {
            await worker.terminate();
            await settled;
          }),
        );
      })();
      return closing;
    },
  };
}
