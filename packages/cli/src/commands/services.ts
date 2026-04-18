import { services as coreServices } from "@openmapx/core";
import type { Command } from "commander";
import { dockerComposeStream } from "../lib/docker";
import { log, table } from "../lib/output";
import { repoPaths } from "../lib/paths";

const { ServiceRegistry } = coreServices;
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
    list = list.filter((s) => s.manifest.provides?.includes(cap));
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
      provides: (s.manifest.provides ?? []).join(", "),
      enabled: s.enabled ? "yes" : "no",
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
}
