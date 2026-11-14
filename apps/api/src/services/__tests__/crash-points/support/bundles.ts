/** The runtime bundles the operations-agent and data-manager images run, built
 * once per test process from this checkout into ignored `dist-temp`
 * directories beside each package's `dist`. */
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { join, relative } from "node:path";

export interface RuntimeBundles {
  /** Directory holding `agent.mjs`, `configuration-handoff-main.mjs` and `cli.mjs`. */
  opsAgent: string;
  /** Directory holding `supervisor.mjs` and the service's worker modules. */
  dataManager: string;
}

let built: Promise<RuntimeBundles> | undefined;

export function runtimeBundles(repo: string): Promise<RuntimeBundles> {
  built ??= (async () => {
    const { buildRuntimeBundle, RUNTIME_BUNDLES, writeRuntimeBundle } = createRequire(
      import.meta.url,
    )(join(repo, "scripts/build-runtime-bundles.mjs"));
    const directories: string[] = [];
    process.once("exit", () => {
      for (const directory of directories) rmSync(directory, { recursive: true, force: true });
    });
    const build = async (name: "ops-agent" | "data-manager", packageDir: string) => {
      const parent = join(repo, packageDir, "dist-temp");
      mkdirSync(parent, { recursive: true });
      const outdir = mkdtempSync(join(parent, "crash-"));
      directories.push(outdir);
      writeRuntimeBundle(
        await buildRuntimeBundle(repo, name, {
          ...RUNTIME_BUNDLES[name],
          outdir: relative(repo, outdir),
        }),
      );
      return outdir;
    };
    return {
      opsAgent: await build("ops-agent", "apps/ops-agent"),
      dataManager: await build("data-manager", "services/data-manager"),
    };
  })();
  return built;
}
