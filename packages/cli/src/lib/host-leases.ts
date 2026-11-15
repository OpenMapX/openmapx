import {
  agentStoreLeases,
  type LeaseBackend,
  type LeaseOperation,
  remoteLeaseBackend,
} from "@openmapx/core/build-artifacts";
import { agentContainerRunning, runsInAgent } from "./agent-integrations";
import { dockerCompose } from "./docker";

/** Runs one lease operation through the fixed CLI in the agent's container. */
async function throughAgentContainer(operation: LeaseOperation): Promise<unknown> {
  const result = await dockerCompose([
    "exec",
    "-T",
    "ops-agent",
    "node",
    "dist/cli.mjs",
    "control",
    "lease",
    JSON.stringify(operation),
  ]);
  if (result.exitCode !== 0)
    throw new Error(
      result.stderr.trim() || "The operations agent could not answer the lease operation",
    );
  return JSON.parse(result.stdout);
}

/**
 * The host CLI's leases. While the agent runs they go through it, as the
 * fixed CLI in its container with the host-CLI token, so the agent stays the
 * only writer of its store. While it is stopped the CLI writes the store under
 * its recoverable lock. Inside the agent's container the store is used directly.
 */
export function hostCliLeases(infraDir: string): LeaseBackend {
  let chosen: Promise<LeaseBackend> | undefined;
  const backend = () => {
    chosen ??= (async () =>
      runsInAgent() || !(await agentContainerRunning())
        ? agentStoreLeases(infraDir, "host-cli")
        : remoteLeaseBackend(throughAgentContainer))();
    return chosen;
  };
  return {
    acquire: async (input) => (await backend()).acquire(input),
    read: async (leaseId) => (await backend()).read(leaseId),
    list: async () => (await backend()).list(),
    delegate: async (input) => (await backend()).delegate(input),
    adopt: async (input) => (await backend()).adopt(input),
    settle: async (input) => (await backend()).settle(input),
    cancel: async (input) => (await backend()).cancel(input),
    release: async (input) => (await backend()).release(input),
  };
}
