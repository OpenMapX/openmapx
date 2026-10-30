/** Fixed configuration helper launch mechanics. These data builders confer no
 * authority: the installed owner/runtime must first join the original frozen
 * step, actual borrowed lease, signed source and one-use helper dispatch. */
import {
  type ExecutionRef,
  executionRefSchema,
  type OpsJobState,
  type OpsOperation,
} from "@openmapx/core/ops";
import { z } from "zod";
import {
  AGENT_HANDOFF_ENTRYPOINT,
  type AgentContainerFacts,
  agentHandoffRunArgs,
  inspectAgentContainer,
} from "./agent-handoff";
import type { DockerCommandRunner } from "./release-images";
import { OpsHostUpdateRequiredError } from "./runtime";

export const CONFIGURATION_HANDOFF_ENTRYPOINT = "dist/configuration-handoff-main.mjs";
export const CONFIGURATION_HANDOFF_LABEL = "openmapx.configuration-handoff";
export const CONFIGURATION_HANDOFF_VERSION = "1";
export const CONFIGURATION_HANDOFF_IMAGE_LABEL = "openmapx.configuration-handoff.version";
const protectedOrder = ["postgis", "redis", "app-web", "app-api", "traefik", "ops-agent"] as const;
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/);
/** Only original inherited environment values participate in the private source
 * copy. Container identity and fixed helper transport necessarily differ. */
export function configurationHandoffEnvironmentNames(facts: AgentContainerFacts): string[] {
  const excluded = new Set([
    "HOSTNAME",
    "DOCKER_CONFIG",
    "OPS_AGENT_HANDOFF_ID",
    "OPS_CONFIGURATION_HANDOFF_ID",
    "OPENMAPX_CONTROL_EXECUTION",
    "OPENMAPX_CONTROL_DELEGATION",
    "OPENMAPX_PARENT_EXECUTION",
  ]);
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
    .parse([...new Set(facts.envNames.filter((name) => !excluded.has(name)))].sort());
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
  const args = agentHandoffRunArgs(
      {
        ...facts,
        envNames: facts.envNames.filter((name) => name !== "OPS_CONFIGURATION_HANDOFF_ID"),
      },
      rootDir,
      handoffId,
    ),
    name = args.indexOf("--name"),
    label = args.indexOf("--label"),
    workdir = args.indexOf("--workdir");
  if (name < 0 || label < 0 || workdir < 0 || args.at(-1) !== AGENT_HANDOFF_ENTRYPOINT)
    throw Error("Fixed helper launch template changed");
  args[name + 1] = `openmapx-configuration-handoff-${handoffId}`;
  args[label + 1] = `${CONFIGURATION_HANDOFF_LABEL}=${handoffId}`;
  args[args.length - 1] = CONFIGURATION_HANDOFF_ENTRYPOINT;
  // Insert before the image/command boundary, preserving mounts, key masking,
  // nonroot identity, no-network and resource confinement from the old helper.
  args.splice(
    workdir,
    0,
    "--env",
    `OPS_CONFIGURATION_HANDOFF_ID=${handoffId}`,
    "--env",
    `OPENMAPX_CONTROL_DELEGATION=${input.assertion}`,
    "--env",
    `OPENMAPX_CONTROL_EXECUTION=${JSON.stringify(execution)}`,
  );
  const legacy = args.indexOf(`OPS_AGENT_HANDOFF_ID=${handoffId}`);
  if (legacy < 1 || args[legacy - 1] !== "--env") throw Error("Fixed helper environment changed");
  args.splice(legacy - 1, 2);
  return args;
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
