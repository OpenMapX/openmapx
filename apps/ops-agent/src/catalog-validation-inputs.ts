/** Fixed, read-only host observations required by catalog validation/publication. */
import { join } from "node:path";
import { catalogRuntimeInputsSchema } from "@openmapx/core/catalog-pins";
import { canonicalJson } from "@openmapx/core/ops";
import { services } from "@openmapx/core/server";
import {
  catalogCompilerSettings,
  catalogReviewInputDigests,
  resolveOperationsProfileFromEnv,
} from "@openmapx/transitous-core";
import { AnchoredDirectory } from "../../../packages/core/src/build-artifacts/filesystem";
import { safeArtifactPath } from "../../../packages/core/src/build-artifacts/manifest";
import { parseFeedOverlay } from "../../../services/data-manager/src/jobs/transitous-feeds-overlay";
import { type DockerRuntimeOptions, runContainedProcess } from "./docker-runtime";
import type { OwnedServiceResolver } from "./owned-services";
import type { OpsRuntime } from "./runtime";
import { inspectAgentPinnedCredentialKeys } from "./transit-credentials-runtime";
export function installCatalogValidationInputsRuntime(
  runtime: OpsRuntime,
  options: {
    rootDir: string;
    stack: services.StackPaths;
    ownedServices: OwnedServiceResolver;
    execFile?: DockerRuntimeOptions["execFile"];
  },
) {
  const inspect = runtime["transitousLock.inspect"],
    docker = options.execFile ?? runContainedProcess;
  runtime["transitousLock.inspect"] = async (operation, context) => {
    const result = await inspect(operation, context);
    if (!result.proposal) return result;
    try {
      const generation = services.currentConfigurationGeneration(options.stack.infraDir);
      if (!generation) throw Error("Apply the instance configuration before catalog validation");
      const compose = JSON.parse(
        (
          await docker(
            "docker",
            [...services.stackComposeArgs(options.stack), "config", "--format", "json"],
            { signal: context.signal, timeout: 30000, maxBuffer: 1024 * 1024 },
          )
        ).stdout,
      );
      const environment = compose.services?.["data-manager"]?.environment;
      if (!environment || typeof environment !== "object" || Array.isArray(environment))
        throw Error("Data Manager policy is unavailable");
      const policy = resolveOperationsProfileFromEnv(environment);
      if (
        environment.MOTIS_TWO_SLOT !== "true" ||
        environment.MOTIS_GBFS_CATALOG_ENABLED !== "true"
      )
        throw Error("Enable paired two-slot catalog validation");
      const owned = await options.ownedServices.inspectOwnedServices(context.signal),
        dm = owned.filter(
          (entry) => entry.serviceId === "data-manager" && entry.state === "running",
        ),
        primary = owned.filter((entry) => entry.serviceId === "motis" && entry.state === "running"),
        staging = owned.filter((entry) => entry.serviceId === "motis-staging");
      if (
        dm.length !== 1 ||
        primary.length !== 1 ||
        staging.length !== 1 ||
        primary[0]!.provenance.imageId !== staging[0]!.provenance.imageId
      )
        throw Error(
          "Run the owned Data Manager and primary MOTIS with the same configured staging image before validation",
        );
      const observed = JSON.parse(
        (
          await docker(
            "docker",
            ["container", "inspect", "--format", "{{json .}}", dm[0]!.containerId],
            { signal: context.signal, timeout: 15000, maxBuffer: 256 * 1024 },
          )
        ).stdout,
      );
      const runningEnvironment = Object.fromEntries(
        (observed?.Config?.Env ?? []).map((entry: string) => {
          const equals = entry.indexOf("=");
          return [entry.slice(0, equals), entry.slice(equals + 1)];
        }),
      );
      if (
        runningEnvironment.MOTIS_TWO_SLOT !== "true" ||
        runningEnvironment.MOTIS_GBFS_CATALOG_ENABLED !== "true"
      )
        throw Error("Apply paired catalog configuration before validation");
      if (
        canonicalJson(resolveOperationsProfileFromEnv(runningEnvironment)) !==
          canonicalJson(policy) ||
        canonicalJson(catalogCompilerSettings(runningEnvironment)) !==
          canonicalJson(catalogCompilerSettings(environment))
      )
        throw Error("Apply pending Data Manager policy changes before validation");
      if (
        environment.TRANSITOUS_FEEDS_OVERLAY_PATH &&
        !String(environment.TRANSITOUS_FEEDS_OVERLAY_PATH).startsWith("/data/")
      )
        throw Error("The host-owned source overlay cannot be verified");
      const relative = environment.TRANSITOUS_FEEDS_OVERLAY_PATH
        ? String(environment.TRANSITOUS_FEEDS_OVERLAY_PATH).replace(/^\/data\//, "")
        : "overrides/feeds-overlay.json";
      if (!safeArtifactPath(relative))
        throw Error("The host-owned source overlay cannot be verified");
      const opened: AnchoredDirectory[] = [];
      let overlay = null;
      try {
        let root = new AnchoredDirectory(join(options.stack.infraDir, "data"));
        opened.push(root);
        const parts = relative.split("/");
        for (const name of parts.slice(0, -1)) {
          root = root.directory(name);
          opened.push(root);
        }
        overlay = parseFeedOverlay(
          JSON.parse(root.read(parts.at(-1)!, 4 * 1024 * 1024, false).toString("utf8")),
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      } finally {
        for (const root of opened.reverse()) root.close();
      }
      const credentials = await runtime["transitCredentials.inspect"](
        {
          kind: "transitCredentials.inspect",
          proposalId: result.proposal.proposalId,
          catalogRevisionId: result.proposal.pins.generationId,
        },
        context,
      );
      if (!credentials.consumedCredentialsRevision)
        throw Error("The running Data Manager credential mount cannot be verified");
      const requiredKeys = await inspectAgentPinnedCredentialKeys(
        options.stack.infraDir,
        result.proposal.pins,
        context.signal,
        { countries: policy.countries, patches: overlay?.patches ?? [] },
      );
      if (services.currentConfigurationGeneration(options.stack.infraDir) !== generation)
        throw Error("Configuration changed during catalog inspection");
      return {
        ...result,
        validationInputs: catalogRuntimeInputsSchema.parse({
          configurationRevisionId: generation,
          credentialsRevision: credentials.consumedCredentialsRevision,
          ...catalogReviewInputDigests(policy, overlay, catalogCompilerSettings(environment)),
          imageDigest: staging[0]!.provenance.imageId,
          stagingState: staging[0]!.state,
          requiredKeys,
          configuredKeys: credentials.configuredKeys,
        }),
      };
    } catch {
      return {
        ...result,
        validationBlocker:
          "Catalog validation needs a verified current policy, required credentials, running Data Manager/primary MOTIS and matching owned staging image. Apply pending configuration and inspect Services.",
      };
    }
  };
}
