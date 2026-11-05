import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { build } from "esbuild";
import { expect, it } from "vitest";

// The deployment uses Linux's inherited descriptor flock. macOS development
// keeps uncertain orphans fenced; the controller also runs these exact fixtures
// in the pinned Linux image rather than substituting a process-liveness check.
it.skipIf(process.platform !== "linux").each(["byte-recovery", "validation-recovery"])(
  "recovers actual killed %s ownership through the production store",
  async (fixture) => {
    const root = await mkdtemp(join(tmpdir(), "omx-native-stage-bundle-"));
    try {
      const output = join(root, "stages.mjs");
      await build({
        entryPoints: [resolve(import.meta.dirname, "test-fixtures/native-stage-entry.ts")],
        bundle: true,
        platform: "node",
        format: "esm",
        outfile: output,
        banner: {
          js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);',
        },
        logLevel: "silent",
      });
      const result = await promisify(execFile)(
        process.execPath,
        [resolve(import.meta.dirname, `test-fixtures/${fixture}.mjs`), output],
        { timeout: 70000, maxBuffer: 65536 },
      );
      const receipt = JSON.parse(result.stdout.trim());
      expect(receipt).toMatchObject({
        passed: true,
        kill: "SIGKILL",
        liveOwnerPreserved: true,
        reservedBytes: 0,
      });
      if (fixture === "validation-recovery")
        expect(receipt).toMatchObject({
          originalCanonicalUnchanged: true,
          managedFilesPublished: false,
        });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  90000,
);
