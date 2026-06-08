import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import type { Command } from "commander";
import { dockerComposeStream } from "../lib/docker";
import { applyGeneratedHardlinks } from "../lib/hardlinks";
import { log } from "../lib/output";
import { repoPaths } from "../lib/paths";
import { combineServiceSelection } from "../lib/preset-selection";
import { applyServiceSelection } from "../lib/service-selection";

const {
  buildAppApiServiceEnv,
  flattenResolvedConfig,
  renderCompose,
  resolveServiceConfigFromEnv,
  ServiceRegistry,
} = coreServices;

export interface RenderRepoOptions {
  rootDir?: string;
  domain: string;
  services?: string[];
}

export interface RenderRepoResult {
  servicesRendered: number;
  composePath: string;
  hardlinkPath: string;
  requestedServiceIds: string[];
  enabledServiceIds: string[];
  selectionWarnings: string[];
  /**
   * Render-time advisories from the compose renderer — currently emitted for
   * optional bind-mounts whose host source is missing and was therefore
   * skipped (see `bindMounts[].optional` in the manifest schema).
   */
  renderWarnings: string[];
}

export async function renderComposeForRepo(opts: RenderRepoOptions): Promise<RenderRepoResult> {
  const paths = repoPaths(opts.rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  const applied = applyServiceSelection(registry, {
    rootDir: paths.root,
    explicitIds: opts.services,
  });
  const enabled = registry.enabled();
  const composeOutDir = dirname(paths.composeOutPath);
  // CLI renders without DB access — the full DB cascade runs in the API path.
  // We still resolve env-var overrides so `SERVICE_<ID>_<KEY>=...` on the host
  // lands in the rendered container env, keeping CLI- and API-produced YAML
  // observationally equivalent when no per-service DB config is set.
  const resolvedServiceConfigs = new Map<string, Record<string, unknown>>();
  for (const s of enabled) {
    // Pass the full manifest so `resolveServiceConfigFromEnv` can suppress
    // schema defaults whose key already exists in `container.environment` —
    // otherwise a boolean `true` default clobbers a manifest "True"/"False"
    // string (see valhalla-scripted).
    const withSources = resolveServiceConfigFromEnv(s.manifest, process.env);
    if (Object.keys(withSources).length > 0) {
      resolvedServiceConfigs.set(s.manifest.id, flattenResolvedConfig(withSources));
    }
  }

  if (enabled.some((s) => s.manifest.id === "app-api")) {
    resolvedServiceConfigs.set(
      "app-api",
      buildAppApiServiceEnv(enabled, resolvedServiceConfigs.get("app-api") ?? {}, process.env),
    );
  }

  const result = renderCompose(enabled, {
    domain: opts.domain,
    composeOutDir,
    allServices: registry.list(),
    resolvedServiceConfigs,
  });

  writeFileSync(paths.composeOutPath, result.composeYaml, "utf-8");
  const hardlinkPath = join(paths.infraDir, "docker-compose.generated.hardlinks.json");
  writeFileSync(hardlinkPath, JSON.stringify(result.hardlinkPlan, null, 2), "utf-8");
  // Pre-create writable data bind-dirs as the invoking (data-owning) user so a
  // later `docker compose up` doesn't auto-create them as root. Runs on every
  // render path that precedes a compose up (start/recreate/up/build/link).
  for (const dir of result.writableBindDirs ?? []) {
    mkdirSync(dir, { recursive: true });
  }
  return {
    servicesRendered: enabled.length,
    composePath: paths.composeOutPath,
    hardlinkPath,
    requestedServiceIds: applied.requestedIds,
    enabledServiceIds: applied.selection.enabledIdsOrdered,
    selectionWarnings: applied.selection.warnings,
    renderWarnings: result.warnings ?? [],
  };
}

export function registerComposeCommands(program: Command): void {
  const compose = program.command("compose").description("Manage docker-compose stack");

  compose
    .command("render")
    .description("Render docker-compose.generated.yml from manifests")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .option("--services <ids>", "Comma/space-separated root service ids for this render")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (options: { domain: string; services?: string; preset?: string }) => {
      try {
        const services = combineServiceSelection(options.services, options.preset);
        const r = await renderComposeForRepo({
          domain: options.domain,
          services,
        });
        log.ok(`Rendered ${r.servicesRendered} services → ${r.composePath}`);
        if (r.enabledServiceIds.length > 0) {
          log.dim(`Selected services → ${r.enabledServiceIds.join(", ")}`);
        }
        for (const warning of r.selectionWarnings) log.warn(warning);
        for (const warning of r.renderWarnings) log.warn(warning);
        log.dim(`Hardlink plan → ${r.hardlinkPath}`);
      } catch (err) {
        log.err(`Render failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  compose
    .command("up")
    .description("Start the stack via generated compose")
    .option("--domain <d>", "Public domain", process.env.DOMAIN ?? "localhost")
    .option("--services <ids>", "Comma/space-separated root service ids for this run")
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (options: { domain: string; services?: string; preset?: string }) => {
      try {
        const services = combineServiceSelection(options.services, options.preset);
        const r = await renderComposeForRepo({
          domain: options.domain,
          services,
        });
        log.ok(`Rendered ${r.servicesRendered} services → ${r.composePath}`);
        for (const warning of r.selectionWarnings) log.warn(warning);
        for (const warning of r.renderWarnings) log.warn(warning);
        const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
        log.ok(
          `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
        );
      } catch (err) {
        log.err(`Render failed: ${(err as Error).message}`);
        process.exit(1);
      }
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

  compose
    .command("pull [ids...]")
    .description("Pull the latest images (no args = all services)")
    .action(async (ids: string[]) => {
      const code = await dockerComposeStream(["pull", ...ids]);
      process.exit(code);
    });
}
