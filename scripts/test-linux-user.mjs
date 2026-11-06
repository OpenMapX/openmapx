// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: Explicit uncached CI launcher.
import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectFilePartition } from "./database-test-shards.mjs";

export const deploymentFiles = [
  "apps/ops-agent",
  "packages/core",
  "services/data-manager",
  "scripts/ops-agent-deployment-user.test.ts",
];
if (import.meta.main) {
  try {
    if (!/^[12]\/2$/.test(process.argv[2] ?? "") || process.argv.length !== 3)
      throw new Error("Usage: test-linux-user.mjs 1/2|2/2");
    const part = Number(process.argv[2][0]);
    // Use the installed shim: it preserves NODE_PATH without requiring a global
    // pnpm binary (the pinned Linux container invokes pnpm through corepack).
    const vitest = resolve(import.meta.dirname, "../node_modules/.bin/vitest");
    const { all, selected } = selectFilePartition({
      filters: deploymentFiles,
      part,
      total: 2,
      collect(args) {
        const result = spawnSync(vitest, args, {
          encoding: "utf8",
          maxBuffer: 32 * 1024 * 1024,
          timeout: 90000,
        });
        if (result.error || result.status !== 0)
          throw new Error(`Linux inventory failed: ${result.error?.message ?? result.stderr}`);
        return JSON.parse(result.stdout);
      },
    });
    if (process.env.OPENMAPX_TEST_SHARD_RECEIPT)
      writeFileSync(
        process.env.OPENMAPX_TEST_SHARD_RECEIPT,
        JSON.stringify({
          group: "linux-user",
          part,
          total: 2,
          source: process.env.GITHUB_SHA,
          all,
          selected,
        }),
      );
    console.log(
      `Linux deployment user ${part}/2: ${selected.length}/${all.length} files, one worker`,
    );
    const result = spawnSync(vitest, ["run", "--project", "node", "--maxWorkers=1", ...selected], {
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    process.exitCode = result.status ?? 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
