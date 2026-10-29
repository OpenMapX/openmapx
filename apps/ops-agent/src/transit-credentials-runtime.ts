/** Fixed read-only catalog/credential inspection. Host paths and values never leave the agent. */
import { createHmac } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { catalogRevisionId, readCatalogPinSet } from "@openmapx/core/catalog-pins";
import type { OpsResultFor } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import { inspectPinnedFeedCredentialKeys, TRANSITOUS_CATALOG_DIR } from "@openmapx/transitous-core";
import { parseFeedCredentialMapJson } from "@openmapx/transitous-core/feed-credentials";
import { AnchoredDirectory } from "../../../packages/core/src/build-artifacts/filesystem";
import { type DockerRuntimeOptions, runContainedProcess } from "./docker-runtime";
import type { OwnedServiceResolver } from "./owned-services";
import { OpsAgentBusyError, OpsNotWiredError, type OpsRuntime } from "./runtime";

const MANAGED = "/run/secrets/TRANSITOUS_API_KEYS";
const DEFAULT = "/config/transitous/api-keys.json";
export function installTransitCredentialsRuntime(
  runtime: OpsRuntime,
  options: {
    rootDir: string;
    sourceToken?: string;
    stack: services.StackPaths;
    ownedServices: OwnedServiceResolver;
    execFile?: DockerRuntimeOptions["execFile"];
  },
) {
  let inspecting = false;
  const docker = options.execFile ?? runContainedProcess;
  runtime["transitCredentials.inspect"] = async (operation, context) => {
    if (inspecting) throw new OpsAgentBusyError();
    inspecting = true;
    try {
      const pair = readCatalogPinSet(options.rootDir);
      if (!pair || catalogRevisionId(pair) !== operation.catalogRevisionId)
        throw new OpsNotWiredError();
      const requiredKeys = await inspectPinnedFeedCredentialKeys({
        catalogDir: join(options.stack.infraDir, "data", TRANSITOUS_CATALOG_DIR),
        transitousCommit: pair.transitous.ref.split("@").at(-1)!,
        atlasCommit: pair.transitous.submodules["transitland-atlas"]!,
        git: async (args, cwd) =>
          (
            await runContainedProcess("git", ["-C", cwd, ...args], {
              signal: context.signal,
              timeout: 30_000,
              maxBuffer: 5 * 1024 * 1024,
            })
          ).stdout,
      });
      // Configuration is collected through the existing fixed Compose argument builder.
      const config = JSON.parse(
        (
          await docker(
            "docker",
            [...services.stackComposeArgs(options.stack), "config", "--format", "json"],
            { signal: context.signal, timeout: 30_000, maxBuffer: 1024 * 1024 },
          )
        ).stdout,
      );
      const env = config.services?.["data-manager"]?.environment ?? {};
      let owner: OpsResultFor<"transitCredentials.inspect">["owner"] = "unset";
      let reason: string | null = null,
        configuredKeys: string[] = [],
        retainedKeys: string[] = [],
        appliedCredentialsRevision: string | null = null,
        hostCredentialsRevision: string | null = null;
      const withDirectory = <T>(
        components: string[],
        read: (directory: AnchoredDirectory) => T,
      ): T => {
        const opened: AnchoredDirectory[] = [];
        try {
          let directory = new AnchoredDirectory(options.rootDir);
          opened.push(directory);
          for (const component of components) {
            directory = directory.directory(component);
            opened.push(directory);
          }
          return read(directory);
        } finally {
          for (const directory of opened.reverse()) directory.close();
        }
      };
      const readMap = (components: string[]) => {
        const parents = components.slice(0, -1),
          file = components.at(-1)!;
        return withDirectory(parents, (directory) => {
          const bytes = directory.read(file, 1024 * 1024, false);
          if (!options.sourceToken) throw new OpsNotWiredError();
          hostCredentialsRevision = createHmac("sha256", options.sourceToken)
            .update("openmapx-host-transit-credentials-v1\0")
            .update(JSON.stringify(components))
            .update("\0")
            .update(bytes)
            .digest("hex");
          const values = parseFeedCredentialMapJson(
            new TextDecoder("utf-8", { fatal: true }).decode(bytes),
          );
          retainedKeys = Object.keys(values).sort();
          return values;
        });
      };
      if (env.TRANSITOUS_API_KEYS_PATH) {
        owner = "environment";
        reason =
          "TRANSITOUS_API_KEYS_PATH is managed on the host. Update that file on the host or explicitly remove the override.";
      } else if (env.TRANSITOUS_API_KEYS_FILE && env.TRANSITOUS_API_KEYS_FILE !== MANAGED) {
        owner = "environment";
        reason = "TRANSITOUS_API_KEYS_FILE is managed on the host.";
      } else if (env.TRANSITOUS_API_KEYS_FILE === MANAGED) {
        owner = "vault";
        const revision = services.currentConfigurationGeneration(options.stack.infraDir);
        if (!revision) throw new OpsNotWiredError();
        const components = [
          "infra",
          "docker",
          services.CONFIGURATION_GENERATIONS,
          revision,
          services.GENERATED_SECRETS_DIRNAME,
          "data-manager",
          "TRANSITOUS_API_KEYS",
        ];
        const values = readMap(components);
        configuredKeys = Object.keys(values)
          .filter((key) => values[key] !== "")
          .sort();
        const owned = (await options.ownedServices.inspectOwnedServices(context.signal)).filter(
          (service) => service.serviceId === "data-manager",
        );
        if (owned.length === 1 && owned[0]!.state === "running") {
          const observed = JSON.parse(
            (
              await docker(
                "docker",
                ["container", "inspect", "--format", "{{json .}}", owned[0]!.containerId],
                {
                  signal: context.signal,
                  timeout: 15_000,
                  maxBuffer: 256 * 1024,
                },
              )
            ).stdout,
          );
          const environment: string[] = observed?.Config?.Env ?? [];
          const mounts: { Source?: string; Destination?: string; RW?: boolean }[] =
            observed?.Mounts ?? [];
          const mount = mounts.filter((item) => item.Destination === MANAGED && item.RW === false);
          const expected = join(options.rootDir, ...components),
            canonicalExpected = join(realpathSync(options.rootDir), ...components),
            stableBase = services.configurationGenerationBasePath(options.stack.infraDir, revision),
            canonicalStableBase = services.configurationGenerationBasePath(
              realpathSync(options.stack.infraDir),
              revision,
            ),
            allowedSources = [
              expected,
              canonicalExpected,
              ...[stableBase, canonicalStableBase].map((base) =>
                join(
                  base,
                  services.GENERATED_SECRETS_DIRNAME,
                  "data-manager",
                  "TRANSITOUS_API_KEYS",
                ),
              ),
            ];
          if (
            mount.length === 1 &&
            mount[0]!.Source &&
            allowedSources.includes(mount[0]!.Source) &&
            environment.includes(`TRANSITOUS_API_KEYS_FILE=${MANAGED}`) &&
            !environment.some(
              (item) =>
                item.startsWith("TRANSITOUS_API_KEYS_PATH=") &&
                item !== "TRANSITOUS_API_KEYS_PATH=",
            )
          ) {
            const a = lstatSync(expected),
              b = lstatSync(mount[0]!.Source!);
            if (
              a.isFile() &&
              b.isFile() &&
              !b.isSymbolicLink() &&
              a.dev === b.dev &&
              a.ino === b.ino &&
              realpathSync(expected) === realpathSync(mount[0]!.Source!)
            )
              appliedCredentialsRevision = services.readAppliedTransitCredentialsRevision(
                options.stack.infraDir,
              );
          }
        }
        if (services.currentConfigurationGeneration(options.stack.infraDir) !== revision)
          throw new OpsNotWiredError();
      } else {
        try {
          const values = readMap(["services", "motis", "tools", "transitous", "api-keys.json"]);
          owner = "file";
          configuredKeys = Object.keys(values)
            .filter((key) => values[key] !== "")
            .sort();
          reason = `The existing ${DEFAULT} file is host-owned. Manage it on the host; it is never adopted automatically.`;
        } catch (error) {
          const entries = withDirectory(["services", "motis", "tools", "transitous"], (directory) =>
            directory.listBounded(1024),
          );
          if (entries.includes("api-keys.json")) throw error;
          owner = "unset";
        }
      }
      const current = readCatalogPinSet(options.rootDir);
      if (!current || catalogRevisionId(current) !== operation.catalogRevisionId)
        throw new OpsNotWiredError();
      return {
        catalogRevisionId: operation.catalogRevisionId,
        requiredKeys,
        owner,
        editable: owner === "vault" || owner === "unset",
        reason,
        configuredKeys,
        retainedKeys,
        appliedCredentialsRevision,
        hostCredentialsRevision: owner === "file" ? hostCredentialsRevision : null,
      };
    } catch (error) {
      if (error instanceof OpsAgentBusyError || error instanceof OpsNotWiredError) throw error;
      throw new OpsNotWiredError();
    } finally {
      inspecting = false;
    }
  };
}
