/** Fixed configuration helper launch mechanics. These data builders confer no
 * authority: the installed owner/runtime must first join the original frozen
 * step, actual borrowed lease, signed source and one-use helper dispatch. */
import { join } from "node:path";
import {
  type ExecutionRef,
  executionRefSchema,
  type OpsJobState,
  type OpsOperation,
} from "@openmapx/core/ops";
import { z } from "zod";
import type { DockerCommandRunner } from "./release-images";
import { OpsHostUpdateRequiredError } from "./runtime";

const CONFIGURATION_HANDOFF_ENTRYPOINT = "dist/configuration-handoff-main.mjs";
export const CONFIGURATION_HANDOFF_LABEL = "openmapx.configuration-handoff";
const CONFIGURATION_HANDOFF_VERSION = "1";
const CONFIGURATION_HANDOFF_IMAGE_LABEL = "openmapx.configuration-handoff.version";
const protectedOrder = ["postgis", "redis", "app-web", "app-api", "traefik", "ops-agent"] as const;
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
const MOUNT_PATH = /^\/[^,\n\r]*$/;
/** More would be no layout this release mounts. */
const MAX_ROOT_MOUNTS = 16;
/** Variables the helper never inherits from the agent: container identity,
 * Docker client state and the control references the helper receives itself. */
const NOT_INHERITED = new Set([
  "HOSTNAME",
  "DOCKER_CONFIG",
  "OPS_CONFIGURATION_HANDOFF_ID",
  "OPENMAPX_CONTROL_EXECUTION",
  "OPENMAPX_CONTROL_DELEGATION",
  "OPENMAPX_PARENT_EXECUTION",
  "OPENMAPX_ROOT_DIR",
]);

/** What the helper container needs to act with exactly the agent's authority. */
export interface AgentContainerFacts {
  imageId: string;
  user: string;
  groups: string[];
  /** Variable names only: `docker run --env NAME` copies each value from the agent. */
  envNames: string[];
  dockerSocketSource: string;
  /**
   * The agent's bind mounts at or under `rootDir`, outermost first: `infra/docker`
   * with its runtime directories. The helper gets the same, so it sees what the
   * agent sees.
   */
  rootMounts: AgentRootMount[];
}

interface AgentRootMount {
  source: string;
  target: string;
  readOnly: boolean;
}

function parseJson(output: string): unknown {
  return JSON.parse(output.trim()) as unknown;
}

/**
 * Reads the running agent's image, identity, environment variable names and
 * the host sources of its Docker socket and root mounts. Environment values
 * are not read here and never appear in the helper's arguments.
 */
export async function inspectAgentContainer(
  runDocker: DockerCommandRunner,
  containerId: string,
  rootDir: string,
  signal: AbortSignal,
): Promise<AgentContainerFacts> {
  const context = { signal, emitLog: () => {} };
  const inspect = async (format: string) =>
    runDocker(["container", "inspect", "--format", format, containerId], context);
  const imageId = (await inspect("{{.Image}}")).trim();
  const user = (await inspect("{{.Config.User}}")).trim();
  const groups = parseJson(await inspect("{{json .HostConfig.GroupAdd}}"));
  const envNames = (
    await inspect('{{range .Config.Env}}{{println (index (split . "=") 0)}}{{end}}')
  )
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean);
  const mounts = parseJson(await inspect("{{json .Mounts}}"));
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((entry) => typeof entry === "string");
  if (
    !/^sha256:[a-f0-9]{64}$/.test(imageId) ||
    !/^[0-9]+(?::[0-9]+)?$/.test(user) ||
    !(groups === null || strings(groups)) ||
    envNames.some((name) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) ||
    !Array.isArray(mounts)
  ) {
    throw new Error("Operations agent container rejected");
  }
  const entries = mounts as Array<{
    Type?: unknown;
    Source?: unknown;
    Destination?: unknown;
    RW?: unknown;
  }>;
  const path = (value: unknown): value is string =>
    typeof value === "string" && MOUNT_PATH.test(value);
  const source = (destination: string): string => {
    const mount = entries.find((entry) => entry.Destination === destination);
    if (!path(mount?.Source)) throw new Error("Operations agent container rejected");
    return mount.Source;
  };
  const rootMounts = entries
    .filter(
      (entry) =>
        typeof entry.Destination === "string" &&
        (entry.Destination === rootDir || entry.Destination.startsWith(`${rootDir}/`)),
    )
    .map((entry) => {
      if (entry.Type !== "bind" || !path(entry.Source) || !path(entry.Destination)) {
        throw new Error("Operations agent container rejected");
      }
      return { source: entry.Source, target: entry.Destination, readOnly: entry.RW !== true };
    })
    .sort((left, right) => left.target.length - right.target.length);
  // The helper reads and writes the agent's state, and Compose reads .env:
  // one writable mount must hold the state directory, and one hold .env.
  const covering = (target: string) =>
    rootMounts.filter((mount) => target === mount.target || target.startsWith(`${mount.target}/`));
  const state = join(rootDir, "infra", "docker", "state");
  if (
    rootMounts.length === 0 ||
    rootMounts.length > MAX_ROOT_MOUNTS ||
    covering(state).at(-1)?.readOnly !== false ||
    covering(join(rootDir, "infra", "docker", ".env")).length === 0
  ) {
    throw new Error("Operations agent container rejected");
  }
  return {
    imageId,
    user,
    groups: groups ?? [],
    envNames,
    dockerSocketSource: source("/var/run/docker.sock"),
    rootMounts,
  };
}

/** Only original inherited environment values participate in the private source
 * copy. Container identity and fixed helper transport necessarily differ. */
export function configurationHandoffEnvironmentNames(facts: AgentContainerFacts): string[] {
  return z
    .array(
      z
        .string()
        .min(1)
        .max(256)
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    )
    .max(256)
    .refine((names) => Buffer.byteLength(JSON.stringify(names)) <= 8192)
    .parse([...new Set(facts.envNames.filter((name) => !NOT_INHERITED.has(name)))].sort());
}
export function configurationHandoffServiceOrder(serviceIds: readonly string[]): string[] {
  const values = z.array(id).min(1).max(64).parse(serviceIds);
  if (new Set(values).size !== values.length) throw Error("Duplicate frozen handoff target");
  const protectedIds = new Set<string>(protectedOrder);
  return [
    ...values.filter((value) => !protectedIds.has(value)).sort(),
    ...protectedOrder.filter((value) => values.includes(value)),
  ];
}
/** Runs the running agent's image with its identity and mounts, sibling role keys
 * and private receipts hidden, no network and confined resources. */
export function configurationHandoffRunArgs(
  facts: AgentContainerFacts,
  rootDir: string,
  input: { handoffId: string; assertion: string; execution: ExecutionRef },
): string[] {
  const handoffId = z.uuid().parse(input.handoffId),
    execution = executionRefSchema.parse(input.execution);
  z.string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_-]+$/)
    .parse(input.assertion);
  if (execution.executor !== "host-cli")
    throw Error("Original configuration helper execution required");
  if (
    !MOUNT_PATH.test(rootDir) ||
    facts.rootMounts.length === 0 ||
    facts.rootMounts.some(
      (mount) =>
        !MOUNT_PATH.test(mount.source) ||
        !MOUNT_PATH.test(mount.target) ||
        (mount.target !== rootDir && !mount.target.startsWith(`${rootDir}/`)),
    )
  ) {
    throw Error("Configuration helper launch rejected");
  }
  // The helper runs Compose with the agent's environment, like the agent's own
  // service updates, so variable interpolation matches.
  const inherited = facts.envNames.filter(
    (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !NOT_INHERITED.has(name),
  );
  const hostSource = (target: string): string => {
    const mount = facts.rootMounts
      .filter((entry) => target === entry.target || target.startsWith(`${entry.target}/`))
      .at(-1);
    if (!mount) throw Error("Configuration helper control mounts unavailable");
    return `${mount.source}${target.slice(mount.target.length)}`;
  };
  // The helper's own mounts: the other roles' keys and private directories
  // hidden, and its control material. The agent masks some of the same
  // targets itself; Docker refuses two mounts at one target, so the helper
  // keeps its own and does not inherit the agent's there.
  const own = [
    ...["ops-agent", "data-manager", "host-cli"].map((role) => ({
      source: hostSource(join(rootDir, "infra/docker/control-private/hidden-key")),
      target: `${rootDir}/infra/docker/secrets/control-${role}.key`,
      readOnly: true,
    })),
    ...["data-manager", "host-cli"].map((role) => ({
      source: hostSource(join(rootDir, "infra/docker/control-private/empty")),
      target: `${rootDir}/infra/docker/control-private/${role}`,
      readOnly: true,
    })),
    {
      source: hostSource(join(rootDir, "infra/docker/control-private/ops-agent")),
      target: "/var/lib/openmapx/control-private",
      readOnly: false,
    },
    {
      source: hostSource(join(rootDir, "infra/docker/secrets/control-verifiers.json")),
      target: "/run/secrets/openmapx-control-verifiers",
      readOnly: true,
    },
  ];
  const mounts = [
    { source: facts.dockerSocketSource, target: "/var/run/docker.sock", readOnly: false },
    ...facts.rootMounts.filter((mount) => !own.some((entry) => entry.target === mount.target)),
    ...own,
  ];
  if (new Set(mounts.map((mount) => mount.target)).size !== mounts.length)
    throw Error("Configuration helper launch rejected");
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    `openmapx-configuration-handoff-${handoffId}`,
    "--label",
    `${CONFIGURATION_HANDOFF_LABEL}=${handoffId}`,
    "--user",
    facts.user,
    ...facts.groups.flatMap((group) => ["--group-add", group]),
    "--network",
    "none",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--memory",
    "256m",
    "--pids-limit",
    "256",
    ...mounts.flatMap((mount) => [
      "--mount",
      `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
    ]),
    ...inherited.flatMap((name) => ["--env", name]),
    "--env",
    "DOCKER_CONFIG=/tmp/docker",
    "--env",
    `OPENMAPX_ROOT_DIR=${rootDir}`,
    "--env",
    `OPS_CONFIGURATION_HANDOFF_ID=${handoffId}`,
    "--env",
    `OPENMAPX_CONTROL_DELEGATION=${input.assertion}`,
    "--env",
    `OPENMAPX_CONTROL_EXECUTION=${JSON.stringify(execution)}`,
    "--workdir",
    "/app/apps/ops-agent",
    "--entrypoint",
    "/sbin/tini",
    facts.imageId,
    "--",
    "node",
    CONFIGURATION_HANDOFF_ENTRYPOINT,
  ];
}
/** The running old image must contain the fixed helper bundle. Docker/Compose
 * reachability alone cannot advertise a supported protected follow-up. Only
 * bounded inspect commands run here; no ownership, pull or launch occurs. */
export async function inspectConfigurationHandoffPrerequisite(input: {
  runDocker: DockerCommandRunner;
  containerId: string;
  imageId: string;
  rootDir: string;
  signal: AbortSignal;
}): Promise<AgentContainerFacts> {
  if (!/^[a-f0-9]{64}$/.test(input.containerId) || !/^sha256:[a-f0-9]{64}$/.test(input.imageId))
    throw new OpsHostUpdateRequiredError();
  try {
    const facts = await inspectAgentContainer(
      input.runDocker,
      input.containerId,
      input.rootDir,
      input.signal,
    );
    if (facts.imageId !== input.imageId) throw new OpsHostUpdateRequiredError();
    configurationHandoffEnvironmentNames(facts);
    const version = (
      await input.runDocker(
        [
          "image",
          "inspect",
          "--format",
          `{{index .Config.Labels "${CONFIGURATION_HANDOFF_IMAGE_LABEL}"}}`,
          facts.imageId,
        ],
        { signal: input.signal, emitLog: () => {} },
      )
    ).trim();
    if (version !== CONFIGURATION_HANDOFF_VERSION) throw new OpsHostUpdateRequiredError();
    return facts;
  } catch (error) {
    input.signal.throwIfAborted();
    if (error instanceof OpsHostUpdateRequiredError) throw error;
    throw new OpsHostUpdateRequiredError();
  }
}

/** Live server jobs are the source; caller-supplied counts are never host
 * authority. Active byte streams are added separately by the actual store. */
export function configurationHandoffBlocksReplacement(
  kind: OpsOperation["kind"],
  state: OpsJobState,
): boolean {
  return (
    ["queued", "running", "termination_pending"].includes(state) &&
    kind !== "service.logs.follow" &&
    kind !== "system.diagnostics"
  );
}
