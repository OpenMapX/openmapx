import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { services as coreServices } from "@openmapx/core";
import type { Command } from "commander";
import { dockerComposeStream } from "../lib/docker";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { ServiceRegistry, renderCompose } = coreServices;

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
  const result = renderCompose(enabled, { domain: opts.domain, composeOutDir });

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
