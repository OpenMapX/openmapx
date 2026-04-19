import { services as coreServices } from "@openmapx/core";
import type { Command } from "commander";
import kleur from "kleur";
import { dockerComposeStream } from "../lib/docker";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";

const {
  checkCapabilityName,
  getProvidedCapabilityNames,
  normalizeProvides,
  ServiceRegistry,
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

export function registerServicesCommands(program: Command): void {
  const services = program.command("services").description("Manage services");

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
    .command("start <id>")
    .description("Start a service")
    .action(async (id: string) => {
      const code = await dockerComposeStream(["up", "-d", id]);
      process.exit(code);
    });

  services
    .command("stop <id>")
    .description("Stop a service")
    .action(async (id: string) => {
      const code = await dockerComposeStream(["stop", id]);
      process.exit(code);
    });

  services
    .command("restart <id>")
    .description("Restart a service")
    .action(async (id: string) => {
      const code = await dockerComposeStream(["restart", id]);
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
