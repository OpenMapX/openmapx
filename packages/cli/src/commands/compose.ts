import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import type { Command } from "commander";
import { dockerComposeStream } from "../lib/docker";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { ServiceRegistry, flattenResolvedConfig, renderCompose, resolveServiceConfigFromEnv } =
  coreServices;

export interface RenderRepoOptions {
  rootDir?: string;
  domain: string;
}

export interface RenderRepoResult {
  servicesRendered: number;
  composePath: string;
  hardlinkPath: string;
}

export async function renderComposeForRepo(opts: RenderRepoOptions): Promise<RenderRepoResult> {
  const paths = repoPaths(opts.rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const enabled = registry.enabled();
  const composeOutDir = dirname(paths.composeOutPath);
  // CLI renders without DB access — the full DB cascade runs in the API path.
  // We still resolve env-var overrides so `SERVICE_<ID>_<KEY>=...` on the host
  // lands in the rendered container env, keeping CLI- and API-produced YAML
  // observationally equivalent when no per-service DB config is set.
  const resolvedServiceConfigs = new Map<string, Record<string, unknown>>();
  for (const s of enabled) {
    const withSources = resolveServiceConfigFromEnv(s.manifest, process.env);
    if (Object.keys(withSources).length > 0) {
      resolvedServiceConfigs.set(s.manifest.id, flattenResolvedConfig(withSources));
    }
  }
  const result = renderCompose(enabled, {
    domain: opts.domain,
    composeOutDir,
    resolvedServiceConfigs,
  });

  writeFileSync(paths.composeOutPath, result.composeYaml, "utf-8");
  const hardlinkPath = join(paths.infraDir, "docker-compose.generated.hardlinks.json");
  writeFileSync(hardlinkPath, JSON.stringify(result.hardlinkPlan, null, 2), "utf-8");
  if (result.envFile) {
    writeFileSync(paths.envOutPath, result.envFile, "utf-8");
  }
  return {
    servicesRendered: enabled.length,
    composePath: paths.composeOutPath,
    hardlinkPath,
  };
}

export function registerComposeCommands(program: Command): void {
  const compose = program.command("compose").description("Manage docker-compose stack");

  compose
    .command("render")
    .description("Render docker-compose.generated.yml from manifests")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .action(async (options: { domain: string }) => {
      try {
        const r = await renderComposeForRepo({ domain: options.domain });
        log.ok(`Rendered ${r.servicesRendered} services → ${r.composePath}`);
        log.dim(`Hardlink plan → ${r.hardlinkPath}`);
      } catch (err) {
        log.err(`Render failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  compose
    .command("up")
    .description("Start the stack via generated compose")
    .action(async () => {
      const code = await dockerComposeStream(["up", "-d"]);
      process.exit(code);
    });

  compose
    .command("down")
    .description("Stop the stack")
    .option("--volumes", "Also remove named volumes (DESTRUCTIVE)")
    .action(async (options: { volumes?: boolean }) => {
      const args = ["down"];
      if (options.volumes) args.push("-v");
      const code = await dockerComposeStream(args);
      process.exit(code);
    });
}
