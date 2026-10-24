import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { OpsAgentHandoffPhase } from "@openmapx/core/ops";
import { atomicWrite } from "@openmapx/core/release-files";
import { services as coreServices } from "@openmapx/core/server";
import { strictReadFile } from "./durable-files";
import {
  type AgentReleasePins,
  createImageInspection,
  type DockerCommandContext,
  type DockerCommandRunner,
} from "./release-images";

/**
 * The ops agent cannot recreate its own container: the Compose client running
 * inside it dies with the old container, part-way through the replacement. A
 * short-lived helper container started from the running (known-good) agent
 * image performs the replacement, verifies the new agent and restores the
 * previous one if it does not become healthy. Every step is recorded here so
 * the API, the new agent and a restarted agent can all see the outcome.
 */

export const AGENT_HANDOFF_LABEL = "openmapx.ops-agent.handoff";
export const AGENT_HANDOFF_ENTRYPOINT = "dist/agent-handoff-main.mjs";
const MAX_HANDOFF_BYTES = 128 * 1024;
const MAX_REASON_LENGTH = 256;
const HANDOFF_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const PHASES = new Set<AgentHandoffPhase>([
  "launched",
  "overlay_written",
  "recreated",
  "applied",
  "rolled_back",
  "failed",
]);
const TERMINAL_PHASES = new Set<AgentHandoffPhase>(["applied", "rolled_back", "failed"]);
const SILENT: Omit<DockerCommandContext, "signal"> = { emitLog: () => {} };

export type AgentHandoffPhase = Exclude<OpsAgentHandoffPhase, "none">;

export interface AgentHandoffRecord {
  version: 1;
  handoffId: string;
  releaseId: string;
  digest: string;
  phase: AgentHandoffPhase;
  /** Overlay bytes before the handoff, restored on rollback; null when absent. */
  previousOverlay: string | null;
  createdAt: string;
  updatedAt: string;
  reason?: string;
  /** Set once a release application has used this handoff's previous overlay. */
  consumed?: boolean;
  /**
   * Set on a handoff imported from an earlier release's state location. Its
   * helper keeps recording there, so this agent settles it once that helper
   * has exited.
   */
  importedFromLegacy?: boolean;
}

export function agentHandoffPath(rootDir: string): string {
  return coreServices.agentStatePaths(join(rootDir, "infra", "docker")).handoff;
}

export function isTerminalHandoff(phase: AgentHandoffPhase): boolean {
  return TERMINAL_PHASES.has(phase);
}

function parseRecord(raw: string): AgentHandoffRecord {
  const value = JSON.parse(raw) as Partial<AgentHandoffRecord> | null;
  if (
    !value ||
    typeof value !== "object" ||
    value.version !== 1 ||
    typeof value.handoffId !== "string" ||
    !HANDOFF_ID.test(value.handoffId) ||
    typeof value.releaseId !== "string" ||
    !HANDOFF_ID.test(value.releaseId) ||
    typeof value.digest !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.digest) ||
    typeof value.phase !== "string" ||
    !PHASES.has(value.phase) ||
    !(value.previousOverlay === null || typeof value.previousOverlay === "string") ||
    typeof value.createdAt !== "string" ||
    typeof value.updatedAt !== "string" ||
    !(value.reason === undefined || typeof value.reason === "string") ||
    !(value.consumed === undefined || typeof value.consumed === "boolean") ||
    !(value.importedFromLegacy === undefined || typeof value.importedFromLegacy === "boolean")
  ) {
    throw new Error("Agent handoff record rejected");
  }
  return value as AgentHandoffRecord;
}

export function readAgentHandoff(rootDir: string): AgentHandoffRecord | null {
  return readAgentHandoffFile(agentHandoffPath(rootDir));
}

/** A handoff record at `path`, or `null` when there is none. */
export function readAgentHandoffFile(path: string): AgentHandoffRecord | null {
  let raw: string;
  try {
    raw = strictReadFile(path, MAX_HANDOFF_BYTES);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error("Agent handoff record rejected");
  }
  return parseRecord(raw);
}

export function writeAgentHandoff(rootDir: string, record: AgentHandoffRecord): void {
  const contents = JSON.stringify(record);
  if (Buffer.byteLength(contents, "utf8") > MAX_HANDOFF_BYTES) {
    throw new Error("Agent handoff record is too large");
  }
  const path = agentHandoffPath(rootDir);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  atomicWrite(path, contents);
}

export function advanceAgentHandoff(
  rootDir: string,
  record: AgentHandoffRecord,
  patch: Pick<AgentHandoffRecord, "phase"> & Partial<Pick<AgentHandoffRecord, "reason">>,
  now: () => Date = () => new Date(),
): AgentHandoffRecord {
  const next: AgentHandoffRecord = {
    ...record,
    ...patch,
    ...(patch.reason === undefined ? {} : { reason: patch.reason.slice(0, MAX_REASON_LENGTH) }),
    updatedAt: now().toISOString(),
  };
  writeAgentHandoff(rootDir, next);
  return next;
}

/** What the helper container needs to act with exactly the agent's authority. */
export interface AgentContainerFacts {
  imageId: string;
  user: string;
  groups: string[];
  /** Variable names only: `docker run --env NAME` copies each value from the agent. */
  envNames: string[];
  dockerSocketSource: string;
  rootSource: string;
}

function parseJson(output: string): unknown {
  return JSON.parse(output.trim()) as unknown;
}

/**
 * Reads the running agent's image, identity, environment variable names and
 * the host sources of its Docker socket and checkout mounts. Environment
 * values are not read here and never appear in the helper's arguments.
 */
export async function inspectAgentContainer(
  runDocker: DockerCommandRunner,
  containerId: string,
  rootDir: string,
  signal: AbortSignal,
): Promise<AgentContainerFacts> {
  const context = { ...SILENT, signal };
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
  const source = (destination: string): string => {
    const mount = (mounts as Array<{ Source?: unknown; Destination?: unknown }>).find(
      (entry) => entry.Destination === destination,
    );
    if (typeof mount?.Source !== "string" || !/^\/[^,\n\r]*$/.test(mount.Source)) {
      throw new Error("Operations agent container rejected");
    }
    return mount.Source;
  };
  return {
    imageId,
    user,
    groups: groups ?? [],
    envNames,
    dockerSocketSource: source("/var/run/docker.sock"),
    rootSource: source(rootDir),
  };
}

export function agentHandoffContainerName(handoffId: string): string {
  return `openmapx-ops-agent-handoff-${handoffId.slice(0, 64)}`;
}

/** `docker run` arguments for the helper: Docker socket and checkout only, no network. */
export function agentHandoffRunArgs(
  facts: AgentContainerFacts,
  rootDir: string,
  handoffId: string,
): string[] {
  if (!HANDOFF_ID.test(handoffId) || !/^\/[^,\n\r]*$/.test(rootDir)) {
    throw new Error("Agent handoff rejected");
  }
  // The helper runs Compose with the agent's environment, like the agent's own
  // service updates, so variable interpolation matches.
  const inherited = facts.envNames.filter(
    (name) =>
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) &&
      !["HOSTNAME", "DOCKER_CONFIG", "OPS_AGENT_HANDOFF_ID"].includes(name),
  );
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    agentHandoffContainerName(handoffId),
    "--label",
    `${AGENT_HANDOFF_LABEL}=${handoffId}`,
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
    "--mount",
    `type=bind,source=${facts.dockerSocketSource},target=/var/run/docker.sock`,
    "--mount",
    `type=bind,source=${facts.rootSource},target=${rootDir}`,
    ...inherited.flatMap((name) => ["--env", name]),
    "--env",
    "DOCKER_CONFIG=/tmp/docker",
    "--env",
    `OPS_AGENT_HANDOFF_ID=${handoffId}`,
    "--workdir",
    "/app/apps/ops-agent",
    "--entrypoint",
    "/sbin/tini",
    facts.imageId,
    "--",
    "node",
    AGENT_HANDOFF_ENTRYPOINT,
  ];
}

export interface AgentHandoffTimeouts {
  /** Lets the old agent return the operation result before it is stopped. */
  graceMs: number;
  /** How long other agent operations may take to finish before giving up. */
  drainMs: number;
  /** How long a recreated agent may take to become healthy. */
  healthMs: number;
  pollMs: number;
}

export const DEFAULT_AGENT_HANDOFF_TIMEOUTS: AgentHandoffTimeouts = {
  graceMs: 3_000,
  drainMs: 60_000,
  healthMs: 180_000,
  pollMs: 2_000,
};

export interface AgentHandoffHelperOptions {
  rootDir: string;
  handoffId: string;
  runDocker: DockerCommandRunner;
  stackArgs(): string[];
  releasePins(releaseId: string, digest: string): AgentReleasePins;
  writeOverlay(releaseId: string, digest: string): void;
  restoreOverlay(previousOverlay: string | null): void;
  withStoreLock<T>(action: () => T): Promise<T>;
  /** Unfinished agent operations other than the agent update itself. */
  activeOperations(): Promise<number>;
  log(message: string): void;
  signal: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  timeouts?: Partial<AgentHandoffTimeouts>;
}

type AgentObservation = "healthy" | "mismatch" | "failed" | "pending";

/** Runs inside the helper container. Returns the terminal phase it recorded. */
export async function runAgentHandoff(
  options: AgentHandoffHelperOptions,
): Promise<AgentHandoffPhase> {
  const timeouts = { ...DEFAULT_AGENT_HANDOFF_TIMEOUTS, ...options.timeouts };
  const sleep = options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms)));
  const now = options.now ?? (() => new Date());
  const context = { signal: options.signal, emitLog: () => {} };
  const { agentMatchesRelease } = createImageInspection(options.runDocker);
  let record = readAgentHandoff(options.rootDir);
  if (!record || record.handoffId !== options.handoffId || record.phase !== "launched") {
    throw new Error("Agent handoff is not awaiting this helper");
  }
  const advance = (patch: Parameters<typeof advanceAgentHandoff>[2]) => {
    record = advanceAgentHandoff(options.rootDir, record as AgentHandoffRecord, patch, now);
    options.log(`Agent handoff ${patch.phase}${patch.reason ? `: ${patch.reason}` : ""}`);
    return record.phase;
  };

  const observe = async (pins?: AgentReleasePins): Promise<AgentObservation> => {
    const ids = (
      await options.runDocker([...options.stackArgs(), "ps", "-q", "ops-agent"], context)
    )
      .trim()
      .split("\n")
      .filter(Boolean);
    if (ids.length !== 1 || !/^[a-f0-9]{12,64}$/.test(ids[0] as string)) return "pending";
    const id = ids[0] as string;
    const [status = "", health = "", restarts = "0"] = (
      await options.runDocker(
        [
          "container",
          "inspect",
          "--format",
          "{{.State.Status}} {{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} {{.RestartCount}}",
          id,
        ],
        context,
      )
    )
      .trim()
      .split(" ");
    if (["exited", "dead", "restarting"].includes(status) || health === "unhealthy")
      return "failed";
    if (Number(restarts) > 0) return "failed";
    if (status !== "running" || health !== "healthy") return "pending";
    if (pins && !(await agentMatchesRelease(id, pins, context))) return "mismatch";
    return "healthy";
  };
  const waitForAgent = async (pins?: AgentReleasePins): Promise<AgentObservation> => {
    const deadline = now().getTime() + timeouts.healthMs;
    while (now().getTime() < deadline) {
      let observation: AgentObservation = "pending";
      try {
        observation = await observe(pins);
      } catch {
        observation = "pending";
      }
      if (observation !== "pending") return observation;
      await sleep(timeouts.pollMs);
    }
    return "pending";
  };
  // Rollback recreates without forcing: Compose replaces the agent only when
  // its configuration differs, so an old agent that never stopped keeps running.
  const recreate = (force: boolean) =>
    options.runDocker(
      [
        ...options.stackArgs(),
        "up",
        "--detach",
        "--no-deps",
        ...(force ? ["--force-recreate"] : []),
        "ops-agent",
      ],
      context,
    );
  const rollback = async (reason: string): Promise<AgentHandoffPhase> => {
    const previousOverlay = (record as AgentHandoffRecord).previousOverlay;
    try {
      await options.withStoreLock(() => options.restoreOverlay(previousOverlay));
      await recreate(false);
      if ((await waitForAgent()) === "healthy") return advance({ phase: "rolled_back", reason });
      return advance({
        phase: "failed",
        reason: `${reason}; the previous agent did not become healthy again`,
      });
    } catch {
      return advance({ phase: "failed", reason: `${reason}; the previous agent was not restored` });
    }
  };

  await sleep(timeouts.graceMs);
  const drainDeadline = now().getTime() + timeouts.drainMs;
  while (true) {
    let active: number;
    try {
      active = await options.activeOperations();
    } catch {
      return advance({
        phase: "rolled_back",
        reason: "The operations journal could not be read; nothing was changed",
      });
    }
    if (active === 0) break;
    if (now().getTime() >= drainDeadline) {
      return advance({
        phase: "rolled_back",
        reason: "Other agent operations were still running; nothing was changed",
      });
    }
    await sleep(timeouts.pollMs);
  }

  let pins: AgentReleasePins;
  try {
    const { releaseId, digest } = record;
    pins = options.releasePins(releaseId, digest);
    await options.withStoreLock(() => options.writeOverlay(releaseId, digest));
  } catch {
    return advance({
      phase: "rolled_back",
      reason: "The checked release could not be read or written; nothing was changed",
    });
  }
  advance({ phase: "overlay_written" });
  // The agent refuses new operations while the handoff is recorded; confirm
  // nothing slipped in before the drain finished.
  let stillIdle = false;
  try {
    stillIdle = (await options.activeOperations()) === 0;
  } catch {
    stillIdle = false;
  }
  if (!stillIdle) {
    const previousOverlay = (record as AgentHandoffRecord).previousOverlay;
    try {
      await options.withStoreLock(() => options.restoreOverlay(previousOverlay));
    } catch {
      return advance({
        phase: "failed",
        reason:
          "An agent operation started during the handoff; the previous overlay was not restored",
      });
    }
    return advance({
      phase: "rolled_back",
      reason: "An agent operation started during the handoff; nothing was changed",
    });
  }
  try {
    await recreate(true);
  } catch {
    return rollback("Compose could not recreate the agent");
  }
  advance({ phase: "recreated" });
  const observation = await waitForAgent(pins);
  if (observation === "healthy") return advance({ phase: "applied" });
  return rollback(
    observation === "mismatch"
      ? "The recreated agent does not run the release image"
      : observation === "failed"
        ? "The new agent stopped or failed its health check"
        : "The new agent did not become healthy in time",
  );
}

export interface AgentHandoffReconcileOptions {
  rootDir: string;
  runDocker: DockerCommandRunner;
  /** Whether the agent running this reconciliation is the handoff's release. */
  runningRelease(record: AgentHandoffRecord): Promise<boolean>;
  restoreOverlay(previousOverlay: string | null): void;
  withStoreLock<T>(action: () => T): Promise<T>;
  now?: () => Date;
}

/**
 * Finishes a handoff whose helper is gone, for example after a host restart.
 * A running helper still owns its handoff and is left alone.
 */
export async function reconcileAgentHandoff(options: AgentHandoffReconcileOptions): Promise<void> {
  const record = readAgentHandoff(options.rootDir);
  if (!record || isTerminalHandoff(record.phase)) return;
  const context = { ...SILENT, signal: AbortSignal.timeout(30_000) };
  const helpers = (
    await options.runDocker(
      ["ps", "--quiet", "--filter", `label=${AGENT_HANDOFF_LABEL}=${record.handoffId}`],
      context,
    )
  ).trim();
  if (helpers !== "") return;
  if (record.phase === "launched") {
    advanceAgentHandoff(
      options.rootDir,
      record,
      { phase: "rolled_back", reason: "The replacement helper stopped before changing anything" },
      options.now,
    );
    return;
  }
  if (await options.runningRelease(record)) {
    advanceAgentHandoff(options.rootDir, record, { phase: "applied" }, options.now);
    return;
  }
  if (record.importedFromLegacy) {
    // Its helper, from the earlier release, restores the previous agent and
    // overlay itself; an imported record carries no overlay to restore.
    advanceAgentHandoff(
      options.rootDir,
      record,
      { phase: "rolled_back", reason: "The replacement helper did not keep this agent" },
      options.now,
    );
    return;
  }
  await options.withStoreLock(() => options.restoreOverlay(record.previousOverlay));
  advanceAgentHandoff(
    options.rootDir,
    record,
    {
      phase: "rolled_back",
      reason: "The replacement helper stopped before finishing; the previous overlay was restored",
    },
    options.now,
  );
}
