import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/**
 * Node options for a worker thread or child process started from another entry
 * module. Callers name the entry as `new URL("./entry.ts", import.meta.url)`:
 * in development and tests that is the TypeScript source, run under tsx
 * resolved from the entry's own package; the runtime bundler rewrites the URL
 * to the bundled `entry.mjs`, which plain Node runs.
 */
export function entryExecArgv(entry: URL): string[] {
  if (!entry.pathname.endsWith(".ts")) return [];
  return ["--import", pathToFileURL(createRequire(entry).resolve("tsx/esm")).href];
}
