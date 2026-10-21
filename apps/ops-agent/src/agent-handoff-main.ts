import { join } from "node:path";
import { createAgentHandoffBindings } from "./administrative-runtime";
import { runAgentHandoff } from "./agent-handoff";
import { runContainedProcess } from "./docker-runtime";
import { readOpsJobJournalSnapshot } from "./journal";

/**
 * Entry point of the agent replacement helper container. It runs from the old
 * agent image with only the Docker socket and the host checkout mounted, and
 * exits once the handoff reaches a terminal phase.
 */
const ACTIVE_STATES = new Set(["queued", "running", "termination_pending"]);

async function main(): Promise<number> {
  const rootDir = process.env.OPENMAPX_ROOT_DIR ?? "";
  const handoffId = process.env.OPS_AGENT_HANDOFF_ID ?? "";
  if (!rootDir.startsWith("/") || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(handoffId)) {
    process.stderr.write("Agent handoff configuration rejected\n");
    return 2;
  }
  const journal = join(rootDir, "infra", "docker", "data", "ops-agent", "jobs-v1.json");
  const bindings = createAgentHandoffBindings(rootDir);
  const phase = await runAgentHandoff({
    rootDir,
    handoffId,
    signal: new AbortController().signal,
    runDocker: async (args, context) =>
      (
        await runContainedProcess("docker", args, {
          signal: context.signal,
          timeout: 5 * 60_000,
          maxBuffer: 1024 * 1024,
        })
      ).stdout,
    ...bindings,
    // The old agent persists every operation it admits. Anything still
    // unfinished, other than the agent update itself, would end with it.
    activeOperations: async () =>
      (await readOpsJobJournalSnapshot(journal)).filter(
        (job) => ACTIVE_STATES.has(job.state) && job.operation.kind !== "agent.update",
      ).length,
    log: (message) => process.stdout.write(`${message}\n`),
  });
  return phase === "applied" ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(
      `Agent handoff failed: ${error instanceof Error ? error.message : "unknown"}\n`,
    );
    process.exitCode = 1;
  },
);
