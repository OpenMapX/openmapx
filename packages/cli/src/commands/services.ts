import { services as coreServices } from "@openmapx/core/server";
import type { Command } from "commander";
import kleur from "kleur";
import { dockerComposeStream } from "../lib/docker";
import { applyGeneratedHardlinks } from "../lib/hardlinks";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";
import { expandPresets, UnknownPresetError } from "../lib/presets";
import { buildServices } from "../lib/service-builds";
import {
  applyServiceSelection,
  disableSelectedServices,
  enableSelectedServices,
  getServiceSelectionSummary,
  SERVICE_SELECTION_FILE,
} from "../lib/service-selection";
import { renderComposeForRepo } from "./compose";

const {
  checkCapabilityName,
  formatServiceIdList,
  getProvidedCapabilityNames,
  normalizeProvides,
  ServiceRegistry,
  SERVICE_SELECTION_ENV,
  WELL_KNOWN_CAPABILITIES,
  WELL_KNOWN_DATA_TYPES,
} = coreServices;
type LoadedService = coreServices.LoadedService;

export interface ListOptions {
  rootDir?: string;
  capability?: string;
  quality?: "built-in" | "community-verified" | "community";
  enabledOnly?: boolean;
}

export async function listServices(opts: ListOptions = {}): Promise<LoadedService[]> {
  const paths = repoPaths(opts.rootDir);
  const registry = new ServiceRegistry({ rootDir: paths.root });
  await registry.load();
  applyServiceSelection(registry, { rootDir: paths.root });
  let list = registry.list();
  if (opts.capability) {
    const cap = opts.capability;
    list = list.filter((s) => getProvidedCapabilityNames(s.manifest.provides).includes(cap));
  }
  if (opts.quality) {
    list = list.filter((s) => s.manifest.quality === opts.quality);
  }
  if (opts.enabledOnly) {
    list = list.filter((s) => s.enabled);
  }
  return list.sort((a, b) => a.manifest.id.localeCompare(b.manifest.id));
}

export function formatServicesTable(list: LoadedService[]): string {
  if (list.length === 0) return "(no services found)";
  return table(
    [
      { key: "id", header: "ID" },
      { key: "version", header: "Version" },
      { key: "quality", header: "Quality" },
      { key: "provides", header: "Provides" },
      { key: "enabled", header: "Enabled" },
    ],
    list.map((s) => ({
      id: s.manifest.id,
      version: s.manifest.version,
      quality: s.manifest.quality,
      provides: getProvidedCapabilityNames(s.manifest.provides).join(", "),
      enabled: s.enabled ? "yes" : "no",
    })),
  );
}

interface CapabilityInventoryRow {
  name: string;
  kind: "capability" | "data-type";
  wellKnown: boolean;
  namespaced: boolean;
  providers: string[];
  consumers?: string[];
}

/**
 * Walk the service registry and group every capability + data-type string by
 * which services declare it. Used by `pnpm openmapx services capabilities`.
 */
export function inventoryCapabilities(services: LoadedService[]): CapabilityInventoryRow[] {
  const caps = new Map<string, CapabilityInventoryRow>();
  const types = new Map<string, CapabilityInventoryRow>();

  function ensure(
    map: Map<string, CapabilityInventoryRow>,
    name: string,
    kind: "capability" | "data-type",
  ) {
    let row = map.get(name);
    if (!row) {
      const check = checkCapabilityName(name, kind);
      row = {
        name,
        kind,
        wellKnown: check.wellKnown,
        namespaced: check.namespaced,
        providers: [],
        ...(kind === "data-type" ? { consumers: [] } : {}),
      };
      map.set(name, row);
    }
    return row;
  }

  for (const s of services) {
    for (const entry of normalizeProvides(s.manifest.provides)) {
      ensure(caps, entry.capability, "capability").providers.push(s.manifest.id);
    }
    for (const p of s.manifest.produces ?? []) {
      ensure(types, p.type, "data-type").providers.push(s.manifest.id);
    }
    for (const c of s.manifest.consumes ?? []) {
      ensure(types, c.type, "data-type").consumers?.push(s.manifest.id);
    }
  }

  // Add unused well-known names so operators see the full vocabulary.
  for (const name of WELL_KNOWN_CAPABILITIES) {
    if (!caps.has(name)) ensure(caps, name, "capability");
  }
  for (const name of WELL_KNOWN_DATA_TYPES) {
    if (!types.has(name)) ensure(types, name, "data-type");
  }

  return [
    ...[...caps.values()].sort((a, b) => a.name.localeCompare(b.name)),
    ...[...types.values()].sort((a, b) => a.name.localeCompare(b.name)),
  ];
}

function statusBadge(row: CapabilityInventoryRow): string {
  if (row.wellKnown) return kleur.green("well-known");
  if (row.namespaced) return kleur.cyan("namespaced");
  return kleur.yellow("unrecognised");
}

export function formatCapabilityInventory(rows: CapabilityInventoryRow[]): string {
  if (rows.length === 0) return "(no capabilities or data types declared)";
  return table(
    [
      { key: "name", header: "Name" },
      { key: "kind", header: "Kind" },
      { key: "status", header: "Status" },
      { key: "providers", header: "Providers" },
      { key: "consumers", header: "Consumers" },
    ],
    rows.map((r) => ({
      name: r.name,
      kind: r.kind,
      status: statusBadge(r),
      providers: r.providers.join(", ") || "—",
      consumers: r.consumers?.join(", ") ?? "—",
    })),
  );
}

/**
 * Merge a positional `ids` list with `--preset` expansions, exiting non-zero
 * with the available preset list when an unknown preset is requested.
 */
function mergeIdsWithPresets(ids: string[], preset: string | undefined): string[] {
  if (!preset) return ids;
  try {
    return [...ids, ...expandPresets([preset])];
  } catch (err) {
    if (err instanceof UnknownPresetError) {
      log.err(err.message);
      process.exit(1);
    }
    throw err;
  }
}

export function registerServicesCommands(program: Command): void {
  const services = program.command("services").description("Manage services");

  services
    .command("selected")
    .description("Show requested and effective selected services")
    .action(async () => {
      try {
        const applied = await getServiceSelectionSummary();
        console.log(`Source: ${applied.source}`);
        console.log(`Requested: ${applied.requestedIds.join(", ") || "(none)"}`);
        console.log(`Effective: ${applied.selection.enabledIdsOrdered.join(", ") || "(none)"}`);
        for (const warning of applied.selection.warnings) log.warn(warning);
      } catch (err) {
        log.err((err as Error).message);
        process.exit(1);
      }
    });

  services
    .command("enable <ids...>")
    .description(`Persistently add services to ${SERVICE_SELECTION_FILE}`)
    .action(async (ids: string[]) => {
      try {
        const state = enableSelectedServices(ids);
        const applied = await getServiceSelectionSummary();
        log.ok(`Selected roots → ${formatServiceIdList(state.selected) || "(none)"}`);
        log.dim(`Effective services → ${formatServiceIdList(applied.selection.enabledIdsOrdered)}`);
        for (const warning of applied.selection.warnings) log.warn(warning);
      } catch (err) {
        log.err((err as Error).message);
        if ((err as Error).message.includes(SERVICE_SELECTION_ENV)) {
          log.dim(`Selection file was not changed.`);
        }
        process.exit(1);
      }
    });

  services
    .command("disable <ids...>")
    .description(`Persistently remove services from ${SERVICE_SELECTION_FILE}`)
    .action(async (ids: string[]) => {
      try {
        const state = disableSelectedServices(ids);
        const applied = await getServiceSelectionSummary();
        log.ok(`Selected roots → ${formatServiceIdList(state.selected) || "(none)"}`);
        log.dim(`Effective services → ${formatServiceIdList(applied.selection.enabledIdsOrdered)}`);
        for (const warning of applied.selection.warnings) log.warn(warning);
      } catch (err) {
        log.err((err as Error).message);
        if ((err as Error).message.includes(SERVICE_SELECTION_ENV)) {
          log.dim(`Selection file was not changed.`);
        }
        process.exit(1);
      }
    });

  services
    .command("list")
    .description("List discovered services")
    .option("--capability <cap>", "Filter by provided capability")
    .option("--quality <q>", "Filter by quality (built-in, community-verified, community)")
    .option("--enabled", "Show only enabled services")
    .action(
      async (options: {
        capability?: string;
        quality?: ListOptions["quality"];
        enabled?: boolean;
      }) => {
        const list = await listServices({
          capability: options.capability,
          quality: options.quality,
          enabledOnly: options.enabled,
        });
        console.log(formatServicesTable(list));
      },
    );

  services
    .command("get <id>")
    .description("Show full manifest for a service")
    .action(async (id: string) => {
      const list = await listServices();
      const svc = list.find((s) => s.manifest.id === id);
      if (!svc) {
        log.err(`Service not found: ${id}`);
        process.exit(1);
      }
      console.log(JSON.stringify(svc.manifest, null, 2));
    });

  services
    .command("build-all")
    .description("Build prepared artifacts for every installed service that declares buildCommand")
    .option(
      "--region <region>",
      "Region selector passed through to build handlers (overrides service-specific env defaults)",
    )
    .option("--fail-fast", "Stop after the first build failure")
    .action(async (options: { region?: string; failFast?: boolean }) => {
      try {
        const result = await buildServices({
          mode: "all",
          region: options.region,
          continueOnError: options.failFast !== true,
        });
        if (result.completedIds.length > 0) {
          const rendered = await renderComposeForRepo({
            domain: process.env.DOMAIN ?? "localhost",
          });
          for (const warning of rendered.selectionWarnings) log.warn(warning);
          const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
          log.ok(
            `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
          );
        }
        if (result.failures.length > 0) {
          log.err(
            `build-all completed with ${result.failures.length} failure${result.failures.length === 1 ? "" : "s"}`,
          );
          process.exit(1);
        }
      } catch (err) {
        log.err(`build-all failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  services
    .command("build <ids...>")
    .description("Build prepared artifacts for one or more services that declare buildCommand")
    .option(
      "--region <region>",
      "Region selector passed through to build handlers (overrides service-specific env defaults)",
    )
    .option("--continue-on-error", "Keep building later services after a failure")
    .action(async (ids: string[], options: { region?: string; continueOnError?: boolean }) => {
      try {
        const result = await buildServices({
          mode: "explicit",
          serviceIds: ids,
          region: options.region,
          continueOnError: options.continueOnError,
        });
        if (result.completedIds.length > 0) {
          const rendered = await renderComposeForRepo({
            domain: process.env.DOMAIN ?? "localhost",
          });
          for (const warning of rendered.selectionWarnings) log.warn(warning);
          const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
          log.ok(
            `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
          );
        }
        if (result.failures.length > 0) {
          log.err(
            `build completed with ${result.failures.length} failure${result.failures.length === 1 ? "" : "s"}`,
          );
          process.exit(1);
        }
      } catch (err) {
        log.err(`build failed: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  services
    .command("start [ids...]")
    .description(
      "Render compose, auto-apply/prune hardlinks, then start one or more services (docker compose up -d)",
    )
    .option(
      "--preset <names>",
      "Comma/space-separated preset names (app, routing, transit, pelias, nominatim, photon, overpass, tiles, martin, proxy, dev)",
    )
    .action(async (ids: string[], options: { preset?: string }) => {
      const allIds = mergeIdsWithPresets(ids, options.preset);
      if (allIds.length === 0) {
        log.err("No services selected. Pass <ids...> or --preset.");
        process.exit(1);
      }
      try {
        const rendered = await renderComposeForRepo({
          domain: process.env.DOMAIN ?? "localhost",
          services: allIds,
        });
        for (const warning of rendered.selectionWarnings) log.warn(warning);
        const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
        log.ok(
          `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
        );
      } catch (err) {
        log.err(`prepare/start failed: ${(err as Error).message}`);
        process.exit(1);
      }
      const code = await dockerComposeStream(["up", "-d", ...allIds]);
      process.exit(code);
    });

  services
    .command("stop [ids...]")
    .description("Stop one or more services (docker compose stop)")
    .option("--preset <names>", "Comma/space-separated preset names")
    .action(async (ids: string[], options: { preset?: string }) => {
      const allIds = mergeIdsWithPresets(ids, options.preset);
      if (allIds.length === 0) {
        log.err("No services selected. Pass <ids...> or --preset.");
        process.exit(1);
      }
      const code = await dockerComposeStream(["stop", ...allIds]);
      process.exit(code);
    });

  services
    .command("restart [ids...]")
    .description(
      "In-place reboot of one or more services (docker compose restart — use `start` to pick up compose-file changes)",
    )
    .option("--preset <names>", "Comma/space-separated preset names")
    .action(async (ids: string[], options: { preset?: string }) => {
      const allIds = mergeIdsWithPresets(ids, options.preset);
      if (allIds.length === 0) {
        log.err("No services selected. Pass <ids...> or --preset.");
        process.exit(1);
      }
      const code = await dockerComposeStream(["restart", ...allIds]);
      process.exit(code);
    });

  services
    .command("recreate [ids...]")
    .description(
      "Pull latest images, then force-recreate one or more services (render + hardlinks + docker compose up -d --force-recreate)",
    )
    .option("--preset <names>", "Comma/space-separated preset names")
    .action(async (ids: string[], options: { preset?: string }) => {
      const allIds = mergeIdsWithPresets(ids, options.preset);
      if (allIds.length === 0) {
        log.err("No services selected. Pass <ids...> or --preset.");
        process.exit(1);
      }
      try {
        const rendered = await renderComposeForRepo({
          domain: process.env.DOMAIN ?? "localhost",
          services: allIds,
        });
        for (const warning of rendered.selectionWarnings) log.warn(warning);
        const linked = await applyGeneratedHardlinks({ prune: true, requirePlan: true });
        log.ok(
          `Applied hardlinks: ${linked.linked} linked, ${linked.skipped} already linked, ${linked.pruned} stale file${linked.pruned === 1 ? "" : "s"} pruned`,
        );
      } catch (err) {
        log.err(`prepare/recreate failed: ${(err as Error).message}`);
        process.exit(1);
      }

      const pullCode = await dockerComposeStream(["pull", ...allIds]);
      if (pullCode !== 0) {
        log.warn("Some images could not be pulled (service may be locally built). Continuing.");
      }

      const code = await dockerComposeStream(["up", "-d", "--force-recreate", ...allIds]);
      process.exit(code);
    });

  services
    .command("status [id]")
    .description("Show container status (one or all services)")
    .action(async (id?: string) => {
      const args = id ? ["ps", id] : ["ps"];
      const code = await dockerComposeStream(args);
      process.exit(code);
    });

  services
    .command("logs <id>")
    .description("Stream service logs")
    .option("--tail <n>", "Number of recent lines", "100")
    .option("--follow", "Follow log output")
    .action(async (id: string, options: { tail: string; follow?: boolean }) => {
      const args = ["logs", `--tail=${options.tail}`];
      if (options.follow) args.push("-f");
      args.push(id);
      const code = await dockerComposeStream(args);
      process.exit(code);
    });

  services
    .command("capabilities")
    .description(
      "Show the capability + data-type vocabulary across the service registry, with which services provide / consume each",
    )
    .option("--unrecognised", "Show only entries that are neither well-known nor namespaced")
    .action(async (options: { unrecognised?: boolean }) => {
      const list = await listServices();
      let rows = inventoryCapabilities(list);
      if (options.unrecognised) {
        rows = rows.filter((r) => !r.wellKnown && !r.namespaced);
        if (rows.length === 0) {
          log.ok("No unrecognised capability / data-type strings declared.");
          return;
        }
      }
      console.log(formatCapabilityInventory(rows));
      const unrecognised = rows.filter((r) => !r.wellKnown && !r.namespaced);
      if (unrecognised.length > 0 && !options.unrecognised) {
        log.warn(
          `${unrecognised.length} entr${unrecognised.length === 1 ? "y is" : "ies are"} neither well-known nor namespaced (e.g. "<vendor>/<name>").`,
        );
      }
    });
}
