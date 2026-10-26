import { lstatSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { services } from "@openmapx/core/server";
import type { DockerRuntimeOptions } from "./docker-runtime";
import type { TrustedConfigurationAuthoritySnapshot } from "./trusted-config-runtime";

export interface OwnedServiceSnapshot {
  serviceId: string;
  containerId: string;
  state: "running" | "stopped" | "created" | "restarting" | "paused" | "unknown";
  provenance: {
    project: string;
    composeWorkingDirectory: string;
    composeConfigFiles: string[];
    imageId: string;
  };
}
/** Docker-host metadata provenance; it does not authenticate a hostile Docker administrator. */
export interface OwnedServiceInventory {
  services: OwnedServiceSnapshot[];
  /** Retention-only observations, never authorization claims. */
  observedContainerIds: string[];
  /** Registered candidates whose provenance could not be verified; denial only. */
  unverifiedServiceIds: string[];
}
export interface OwnedServiceResolver {
  inspectOwnedServices(signal: AbortSignal): Promise<OwnedServiceSnapshot[]>;
  inspectInventory?(signal: AbortSignal): Promise<OwnedServiceInventory>;
}
const FAILED = "Owned service inventory unavailable";
const ID = /^[a-f0-9]{64}$/;
const IMAGE = /^sha256:[a-f0-9]{64}$/;
const FORMAT =
  '{"Id":{{json .Id}},"Image":{{json .Image}},"State":{{json .State.Status}},"ConfigImage":{{json .Config.Image}},"Labels":{{json .Config.Labels}}}';

export function createOwnedServiceResolver(options: {
  stack: services.StackPaths;
  execFile: NonNullable<DockerRuntimeOptions["execFile"]>;
  loadAuthority(): Promise<TrustedConfigurationAuthoritySnapshot>;
}): OwnedServiceResolver {
  const inspectInventory = async (signal: AbortSignal): Promise<OwnedServiceInventory> => {
    signal = AbortSignal.any([signal, AbortSignal.timeout(15_000)]);
    const run = async (args: string[]) => {
      signal.throwIfAborted();
      const result = await options.execFile("docker", args, {
        signal,
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      });
      signal.throwIfAborted();
      if (Buffer.byteLength(result.stdout) > 1024 * 1024) throw new Error(FAILED);
      return result.stdout;
    };
    try {
      const authority = await options.loadAuthority();
      if (
        authority.services.length > 256 ||
        new Set(authority.services.map((s) => s.manifest.id)).size !== authority.services.length
      )
        throw new Error(FAILED);
      const registry = new Map(authority.services.map((s) => [s.manifest.id, s]));
      const listing = (
        await run([
          "container",
          "ls",
          "--all",
          "--no-trunc",
          "--filter",
          `label=com.docker.compose.project=${services.STACK_PROJECT}`,
          "--format",
          "{{.ID}}",
        ])
      ).trim();
      const ids = listing ? listing.split(/\r?\n/) : [];
      if (ids.length > 256 || ids.some((id) => !ID.test(id)) || new Set(ids).size !== ids.length)
        throw new Error(FAILED);
      if (!ids.length) return { services: [], observedContainerIds: [], unverifiedServiceIds: [] };
      const rows = (await run(["container", "inspect", "--format", FORMAT, ...ids]))
        .trim()
        .split(/\r?\n/);
      if (rows.length !== ids.length) throw new Error(FAILED);
      const infra = realpathSync(options.stack.infraDir);
      const configuredInfra = resolve(options.stack.infraDir);
      const canonical = (path: string): string => {
        if (![infra, configuredInfra].some((root) => path === root || path.startsWith(`${root}/`)))
          throw new Error(FAILED);
        if (!path.startsWith("/") || path !== resolve(path) || /[\0\r\n]/.test(path))
          throw new Error(FAILED);
        return realpathSync(path);
      };
      const found: OwnedServiceSnapshot[] = [];
      const candidates = new Set<string>();
      const images = new Map<string, string>();
      const configurations = new Map<string, Record<string, { image?: string }>>();
      for (let index = 0; index < rows.length; index++) {
        const row = JSON.parse(rows[index] ?? "") as Record<string, unknown>;
        if (
          row.Id !== ids[index] ||
          typeof row.Image !== "string" ||
          !IMAGE.test(row.Image) ||
          typeof row.State !== "string" ||
          typeof row.ConfigImage !== "string" ||
          !row.Labels ||
          typeof row.Labels !== "object" ||
          Array.isArray(row.Labels)
        )
          throw new Error(FAILED);
        const labels = row.Labels as Record<string, unknown>;
        const serviceId = labels["com.docker.compose.service"];
        if (
          labels["com.docker.compose.project"] !== services.STACK_PROJECT ||
          typeof serviceId !== "string" ||
          !registry.has(serviceId)
        )
          continue;
        candidates.add(serviceId);
        const working = labels["com.docker.compose.project.working_dir"];
        const files = labels["com.docker.compose.project.config_files"];
        if (typeof working !== "string" || typeof files !== "string" || files.length > 8192)
          continue;
        let configFiles: string[], workingDirectory: string;
        try {
          configFiles = files.split(",").map(canonical);
          workingDirectory = canonical(working);
        } catch {
          continue;
        }
        const first = configFiles[0];
        const generation = first?.slice(`${infra}/${services.CONFIGURATION_GENERATIONS}/`.length);
        const generationFile =
          first?.startsWith(`${infra}/${services.CONFIGURATION_GENERATIONS}/`) &&
          /^cfg1_[A-Za-z0-9_-]{43}\/docker-compose.generated.yml$/.test(generation ?? "");
        if (
          !first ||
          (!generationFile && first !== join(infra, services.GENERATED_COMPOSE_FILE)) ||
          ![infra, dirname(first)].includes(workingDirectory) ||
          configFiles.length > 2 ||
          new Set(configFiles).size !== configFiles.length ||
          (configFiles[1] !== undefined &&
            (configFiles[1] !== join(infra, "docker-compose.release.yml") ||
              configFiles[1] !== canonical(options.stack.composeReleasePath)))
        )
          continue;
        try {
          if (generationFile)
            services.configurationGenerationComposeFile(
              infra,
              dirname(first).split("/").at(-1) ?? "",
            );
          for (const file of configFiles) {
            const stat = lstatSync(file);
            if (
              !stat.isFile() ||
              stat.isSymbolicLink() ||
              stat.uid !== (process.geteuid?.() ?? 0) ||
              (stat.mode & 0o022) !== 0 ||
              stat.nlink !== 1
            )
              throw new Error(FAILED);
          }
        } catch {
          continue;
        }
        const key = JSON.stringify(configFiles);
        let configuration = configurations.get(key);
        if (!configuration) {
          const config = JSON.parse(
            await run([
              "compose",
              "--project-name",
              services.STACK_PROJECT,
              ...configFiles.flatMap((file) => ["-f", file]),
              ...realpathEnv(infra),
              "config",
              "--format",
              "json",
            ]),
          ) as { services?: Record<string, { image?: string }> };
          if (
            !config.services ||
            typeof config.services !== "object" ||
            Array.isArray(config.services) ||
            Object.keys(config.services).length > 256 ||
            Object.values(config.services).some(
              (entry) =>
                !entry ||
                typeof entry !== "object" ||
                Array.isArray(entry) ||
                (entry.image !== undefined && typeof entry.image !== "string"),
            )
          )
            throw new Error(FAILED);
          configuration = config.services;
          configurations.set(key, configuration);
        }
        // Deselection removes Compose membership, but the registered manifest
        // remains authority for its effective image. Release overlays still win
        // when they provide an explicit image for that service.
        const registered = registry.get(serviceId);
        const reference =
          configuration[serviceId]?.image ??
          (registered
            ? services.serviceContainerImageReference(registered.manifest.container)
            : undefined);
        if (
          !reference ||
          row.ConfigImage !== reference ||
          reference.length > 512 ||
          /[\0\r\n]/.test(reference)
        )
          continue;
        let imageId = images.get(reference);
        if (!imageId) {
          imageId = (await run(["image", "inspect", "--format", "{{.Id}}", reference])).trim();
          if (!IMAGE.test(imageId)) throw new Error(FAILED);
          images.set(reference, imageId);
        }
        if (row.Image !== imageId) continue;
        if (found.some((entry) => entry.serviceId === serviceId)) throw new Error(FAILED);
        found.push({
          serviceId,
          containerId: row.Id as string,
          state:
            row.State === "exited" || row.State === "dead"
              ? "stopped"
              : ["running", "stopped", "created", "restarting", "paused"].includes(row.State)
                ? (row.State as OwnedServiceSnapshot["state"])
                : "unknown",
          provenance: {
            project: services.STACK_PROJECT,
            composeWorkingDirectory: workingDirectory,
            composeConfigFiles: configFiles,
            imageId,
          },
        });
      }
      return {
        services: found,
        observedContainerIds: ids,
        unverifiedServiceIds: [...candidates].filter(
          (id) => !found.some((service) => service.serviceId === id),
        ),
      };
    } catch {
      throw new Error(FAILED);
    }
  };
  return {
    inspectInventory,
    inspectOwnedServices: async (signal) => (await inspectInventory(signal)).services,
  };
}

function realpathEnv(infra: string): string[] {
  try {
    return ["--env-file", realpathSync(join(infra, ".env"))];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
