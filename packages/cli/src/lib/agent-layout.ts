import { lstatSync } from "node:fs";
import { join } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { runsInAgent } from "./agent-integrations";
import { containerBindMounts } from "./container-mounts";
import { log } from "./output";
import { repoPaths } from "./paths";
import { transitousApiKeysPath } from "./transitous-api-keys";

/**
 * The operations agent moves from the whole checkout to its narrow mounts
 * (`infra/docker` read-only, its state, data, secrets and backups
 * directories read-write) only in a render on the host, and only once
 * nothing an agent without the checkout needs is missing. This is what is
 * missing, each with its fix; empty when the switch may happen.
 */
export function narrowAgentLayoutBlockers(input: {
  rootDir: string;
  /** Every container's bind mounts; undefined when Docker can't tell. */
  mounts: readonly coreServices.ContainerBindMounts[] | undefined;
}): string[] {
  const { rootDir } = input;
  const infraDir = join(rootDir, "infra", "docker");
  const state = "infra/docker/state/ops-agent";
  const blockers: string[] = [];
  try {
    coreServices.readDeploymentUser(infraDir);
  } catch (error) {
    blockers.push((error as Error).message);
  }
  if (!coreServices.serviceFilesImported(infraDir)) {
    blockers.push(
      `The one-time import of your edits in the checkout's service files has not run (${state}/overrides-import.json is missing). It runs in a render that uses a release's service files: select a release with \`pnpm openmapx compose release\`, see what the render says about the import, and render again.`,
    );
  }
  if (coreServices.readAgentStoresMigration(infraDir) === null) {
    blockers.push(
      `The agent's community and integration stores have not been copied out of the checkout (${state}/stores-migration.json is missing): render again.`,
    );
  }
  if (coreServices.legacyConfigurationWriterActive(infraDir)) {
    blockers.push(
      `Writers still take the earlier releases' configuration lock in infra/docker (${state}/legacy-configuration-writer-retired.json is missing): start this release's operations agent with \`pnpm openmapx services update ops-agent\`, which records it once no handoff helper runs, then render again.`,
    );
  }
  try {
    lstatSync(transitousApiKeysPath(infraDir));
  } catch {
    blockers.push(
      "The Transitous API keys have not been copied out of the checkout (infra/docker/secrets/transitous-api-keys/api-keys.json is missing): render again.",
    );
  }
  const release = coreServices.legacyReleaseStatePending(infraDir);
  if (release) blockers.push(release);
  if (coreServices.currentConfigurationGeneration(infraDir) === null) {
    blockers.push(
      `No configuration generation is applied yet (${state}/configuration/current is missing): render again once one is.`,
    );
  }
  if (input.mounts === undefined) {
    blockers.push(
      "Docker could not list the containers' mounts, so whether one still mounts the checkout's services/ is not known: make sure `docker ps --all` works for this user, then render again.",
    );
  } else {
    const services = `${rootDir.replace(/\/+$/, "")}/services/`;
    const names = input.mounts
      .filter((mount) => mount.sources.some((source) => source.startsWith(services)))
      .map((mount) => mount.name)
      .sort();
    if (names.length > 0) {
      blockers.push(
        `${names.join(", ")} still mount${names.length === 1 ? "s" : ""} files from the checkout's services/, which an agent without the checkout can't keep up to date (Traefik's routes among them): recreate ${names.length === 1 ? "it" : "each"} with \`pnpm openmapx services update <service>\`, then render again.`,
      );
    }
  }
  return blockers;
}

/** What render and the host update say when the agent keeps the whole checkout. */
export function describeAgentLayoutBlockers(blockers: readonly string[]): string {
  return `The operations agent keeps the whole checkout mounted. It moves to its narrow mounts in a render on the host once nothing it needs is missing; now ${blockers.length === 1 ? "this is" : `these ${blockers.length} are`}:\n${blockers.map((blocker) => `- ${blocker}`).join("\n")}`;
}

/**
 * Before a host command recreates the operations agent: the applied
 * generation mounts it narrowly while the running agent still has the whole
 * checkout, so this would switch it. Refuses, naming what is missing, when
 * anything the switch needs is missing now; nothing is recreated then. The
 * agent's fixed CLI never recreates the agent, and never switches it.
 */
export async function refuseUnreadyAgentSwitch(
  recreates: "all" | readonly string[],
): Promise<void> {
  if (runsInAgent()) return;
  if (recreates !== "all" && !recreates.includes("ops-agent")) return;
  const paths = repoPaths();
  if (coreServices.generationAgentMountLayout(paths.infraDir) !== "narrow") return;
  const mounts = await containerBindMounts();
  // An agent that already runs without the checkout has nothing to switch.
  if (mounts && !mounts.some((mount) => mount.sources.includes(paths.root))) return;
  const blockers = narrowAgentLayoutBlockers({ rootDir: paths.root, mounts });
  if (blockers.length === 0) return;
  throw new Error(
    `The operations agent is not recreated with its narrow mounts. ${describeAgentLayoutBlockers(blockers)}`,
  );
}

/** {@link refuseUnreadyAgentSwitch} for a command: says why and exits, recreating nothing. */
export async function refuseAgentSwitchOrExit(recreates: "all" | readonly string[]): Promise<void> {
  try {
    await refuseUnreadyAgentSwitch(recreates);
  } catch (error) {
    log.err((error as Error).message);
    process.exit(1);
  }
}
