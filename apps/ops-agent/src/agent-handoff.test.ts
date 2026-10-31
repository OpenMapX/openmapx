import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AgentContainerFacts,
  type AgentHandoffRecord,
  agentHandoffRunArgs,
  inspectAgentContainer,
  readAgentHandoff,
  reconcileAgentHandoff,
  runAgentHandoff,
  writeAgentHandoff,
} from "./agent-handoff";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const agentImage = `ghcr.io/openmapx/ops-agent@sha256:${"1".repeat(64)}`;
const helperImage = `ghcr.io/openmapx/privacy-backup@sha256:${"2".repeat(64)}`;
const newImageId = `sha256:${"1".repeat(64)}`;
const oldImageId = `sha256:${"9".repeat(64)}`;
const containerId = "c".repeat(64);

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), "openmapx-agent-handoff-"));
  roots.push(directory);
  mkdirSync(join(directory, "infra", "docker", "state", "ops-agent"), {
    recursive: true,
    mode: 0o700,
  });
  return directory;
}

function record(phase: AgentHandoffRecord["phase"] = "launched"): AgentHandoffRecord {
  return {
    version: 1,
    handoffId: "handoff-1",
    releaseId: "release-2",
    digest: "d".repeat(64),
    phase,
    previousOverlay: "previous-overlay\n",
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
  };
}

interface AgentState {
  status: string;
  health: string;
  restarts: number;
  imageId: string;
  helper: string;
}

/**
 * A fake Docker daemon: `up` replaces the agent container with whatever the
 * test's `next` callback returns for the current overlay.
 */
function harness(
  rootDir: string,
  options: {
    afterUp: (overlay: string | null, attempt: number) => AgentState | Error;
    active?: () => Promise<number>;
    releaseReadable?: boolean;
  },
) {
  let clock = Date.parse("2026-10-21T00:00:00.000Z");
  let overlay: string | null = "previous-overlay\n";
  let agent: AgentState = {
    status: "running",
    health: "healthy",
    restarts: 0,
    imageId: oldImageId,
    helper: "old-helper",
  };
  let ups = 0;
  const calls: string[] = [];
  const runDocker = vi.fn(async (args: readonly string[]) => {
    const joined = args.join(" ");
    calls.push(joined);
    if (args.includes("up")) {
      ups += 1;
      const next = options.afterUp(overlay, ups);
      if (next instanceof Error) throw next;
      agent = next;
      return "";
    }
    if (args.includes("ps")) return `${containerId}\n`;
    if (joined.includes("{{.State.Status}}"))
      return `${agent.status} ${agent.health} ${agent.restarts}`;
    if (joined.includes("{{.Image}}")) return agent.imageId;
    if (joined.includes(".Config.Env"))
      return `OPS_PRIVACY_BACKUP_COLLECTOR_IMAGE=${agent.helper}\n`;
    if (joined.includes("{{.Id}}") && joined.endsWith(agentImage)) return newImageId;
    if (joined.includes("RepoDigests")) return "[]";
    throw new Error(`Unexpected Docker call: ${joined}`);
  });
  const writeOverlay = vi.fn(() => {
    overlay = "release-2-overlay\n";
  });
  const restoreOverlay = vi.fn((previous: string | null) => {
    overlay = previous;
  });
  const run = () =>
    runAgentHandoff({
      rootDir,
      handoffId: "handoff-1",
      runDocker,
      stackArgs: () => ["compose", "-f", "stack.yml"],
      releasePins: () => {
        if (options.releaseReadable === false) throw new Error("Release authority rejected");
        return { agentImage, helperImage };
      },
      writeOverlay,
      restoreOverlay,
      withStoreLock: async (action) => action(),
      activeOperations: options.active ?? (async () => 0),
      log: () => {},
      signal: new AbortController().signal,
      now: () => new Date(clock),
      sleep: async (ms) => {
        clock += ms;
      },
    });
  return { run, calls, writeOverlay, restoreOverlay, overlay: () => overlay };
}

const healthyNew: AgentState = {
  status: "running",
  health: "healthy",
  restarts: 0,
  imageId: newImageId,
  helper: helperImage,
};
const healthyOld: AgentState = {
  status: "running",
  health: "healthy",
  restarts: 0,
  imageId: oldImageId,
  helper: "old-helper",
};

describe("agent handoff helper", () => {
  it("writes the release overlay, recreates the agent and records the verified result", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, { afterUp: () => healthyNew });

    await expect(h.run()).resolves.toBe("applied");
    expect(readAgentHandoff(rootDir)).toMatchObject({ phase: "applied" });
    expect(h.writeOverlay).toHaveBeenCalledWith("release-2", "d".repeat(64));
    expect(h.restoreOverlay).not.toHaveBeenCalled();
    expect(h.calls.filter((call) => call.includes(" up "))).toEqual([
      "compose -f stack.yml up --detach --no-deps --force-recreate ops-agent",
    ]);
  });

  it.each([
    ["fails its health check", { ...healthyNew, health: "unhealthy" }, "health check"],
    ["keeps restarting", { ...healthyNew, status: "restarting", restarts: 2 }, "health check"],
    ["exits", { ...healthyNew, status: "exited" }, "health check"],
    ["runs another image", { ...healthyNew, imageId: `sha256:${"7".repeat(64)}` }, "release image"],
    ["keeps the old helper pin", { ...healthyNew, helper: "old-helper" }, "release image"],
  ])("restores the previous agent when the new one %s", async (_case, state, reason) => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, {
      afterUp: (overlay) => (overlay === "previous-overlay\n" ? healthyOld : state),
    });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(h.restoreOverlay).toHaveBeenCalledWith("previous-overlay\n");
    expect(h.overlay()).toBe("previous-overlay\n");
    expect(readAgentHandoff(rootDir)?.reason).toContain(reason);
    expect(h.calls.filter((call) => call.includes(" up "))).toEqual([
      "compose -f stack.yml up --detach --no-deps --force-recreate ops-agent",
      "compose -f stack.yml up --detach --no-deps ops-agent",
    ]);
  });

  it("restores the previous agent when the new one never becomes healthy", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, {
      afterUp: (overlay) =>
        overlay === "previous-overlay\n" ? healthyOld : { ...healthyNew, health: "starting" },
    });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(readAgentHandoff(rootDir)?.reason).toContain("in time");
  });

  it("restores the previous overlay when Compose cannot recreate the agent", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, {
      afterUp: (_overlay, attempt) => (attempt === 1 ? new Error("compose failed") : healthyOld),
    });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(h.restoreOverlay).toHaveBeenCalledWith("previous-overlay\n");
    expect(readAgentHandoff(rootDir)?.reason).toContain("Compose");
  });

  it("records a failure when the previous agent does not come back either", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, { afterUp: () => ({ ...healthyNew, health: "unhealthy" }) });

    await expect(h.run()).resolves.toBe("failed");
    expect(readAgentHandoff(rootDir)?.reason).toContain("did not become healthy again");
  });

  it("changes nothing while other agent operations keep running", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, { afterUp: () => healthyNew, active: async () => 1 });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(h.writeOverlay).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.includes(" up "))).toBe(false);
  });

  it("waits for other operations to finish before replacing the agent", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    let checks = 0;
    const h = harness(rootDir, {
      afterUp: () => healthyNew,
      active: async () => (++checks < 3 ? 1 : 0),
    });

    await expect(h.run()).resolves.toBe("applied");
    // Three reads while draining, and one more just before the recreate.
    expect(checks).toBe(4);
  });

  it("puts the previous overlay back when an operation starts during the handoff", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    let checks = 0;
    const h = harness(rootDir, {
      afterUp: () => healthyNew,
      active: async () => (++checks === 1 ? 0 : 1),
    });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(h.writeOverlay).toHaveBeenCalled();
    expect(h.restoreOverlay).toHaveBeenCalledWith("previous-overlay\n");
    expect(h.calls.some((call) => call.includes(" up "))).toBe(false);
  });

  it("changes nothing when the operations journal cannot be read", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, {
      afterUp: () => healthyNew,
      active: async () => {
        throw new Error("unreadable");
      },
    });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(h.writeOverlay).not.toHaveBeenCalled();
  });

  it("changes nothing when the checked release cannot be read", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record());
    const h = harness(rootDir, { afterUp: () => healthyNew, releaseReadable: false });

    await expect(h.run()).resolves.toBe("rolled_back");
    expect(h.writeOverlay).not.toHaveBeenCalled();
    expect(h.calls.some((call) => call.includes(" up "))).toBe(false);
  });

  it("only acts on a launched handoff with its own ID", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record("applied"));
    const h = harness(rootDir, { afterUp: () => healthyNew });

    await expect(h.run()).rejects.toThrow("not awaiting this helper");
    expect(h.calls).toEqual([]);
  });
});

describe("agent handoff reconciliation", () => {
  function reconcile(
    rootDir: string,
    options: { helperRunning?: boolean; runningRelease?: boolean } = {},
  ) {
    const restoreOverlay = vi.fn();
    const runDocker = vi.fn(async () => (options.helperRunning ? "abc123\n" : ""));
    return {
      restoreOverlay,
      runDocker,
      done: reconcileAgentHandoff({
        rootDir,
        runDocker,
        runningRelease: async () => options.runningRelease ?? false,
        restoreOverlay,
        withStoreLock: async (action) => action(),
      }),
    };
  }

  it("leaves a handoff alone while its helper is still running", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record("recreated"));
    const r = reconcile(rootDir, { helperRunning: true });
    await r.done;
    expect(readAgentHandoff(rootDir)?.phase).toBe("recreated");
    expect(r.runDocker).toHaveBeenCalledWith(
      ["ps", "--quiet", "--filter", "label=openmapx.ops-agent.handoff=handoff-1"],
      expect.anything(),
    );
  });

  it("closes a launched handoff whose helper never changed anything", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record("launched"));
    const r = reconcile(rootDir);
    await r.done;
    expect(readAgentHandoff(rootDir)?.phase).toBe("rolled_back");
    expect(r.restoreOverlay).not.toHaveBeenCalled();
  });

  it("completes an interrupted handoff when the release agent is running", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record("recreated"));
    const r = reconcile(rootDir, { runningRelease: true });
    await r.done;
    expect(readAgentHandoff(rootDir)?.phase).toBe("applied");
    expect(r.restoreOverlay).not.toHaveBeenCalled();
  });

  it("restores the previous overlay when the old agent is still running", async () => {
    const rootDir = root();
    writeAgentHandoff(rootDir, record("overlay_written"));
    const r = reconcile(rootDir, { runningRelease: false });
    await r.done;
    expect(r.restoreOverlay).toHaveBeenCalledWith("previous-overlay\n");
    expect(readAgentHandoff(rootDir)?.phase).toBe("rolled_back");
  });

  it("does nothing without a handoff or after a terminal one", async () => {
    const rootDir = root();
    await reconcile(rootDir).done;
    writeAgentHandoff(rootDir, record("applied"));
    const r = reconcile(rootDir);
    await r.done;
    expect(r.runDocker).not.toHaveBeenCalled();
  });
});

describe("agent handoff helper container", () => {
  const facts: AgentContainerFacts = {
    imageId: oldImageId,
    user: "1000:1000",
    groups: ["999"],
    envNames: ["PATH", "HOSTNAME", "DOCKER_CONFIG", "OPENMAPX_ROOT_DIR"],
    dockerSocketSource: "/var/run/docker.sock",
    rootMounts: [{ source: "/srv/openmapx", target: "/srv/openmapx", readOnly: false }],
  };
  const narrow: AgentContainerFacts = {
    ...facts,
    rootMounts: [
      {
        source: "/srv/openmapx/infra/docker",
        target: "/srv/openmapx/infra/docker",
        readOnly: true,
      },
      ...["state", "data", "secrets", "backups"].map((name) => ({
        source: `/srv/openmapx/infra/docker/${name}`,
        target: `/srv/openmapx/infra/docker/${name}`,
        readOnly: false,
      })),
    ],
  };

  it("runs the agent image with isolated control material, no network and no privileges", () => {
    const args = agentHandoffRunArgs(facts, "/srv/openmapx", "handoff-1");
    expect(args.slice(0, 3)).toEqual(["run", "--detach", "--rm"]);
    expect(args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "no-new-privileges",
        "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
        "type=bind,source=/srv/openmapx,target=/srv/openmapx",
        "openmapx.ops-agent.handoff=handoff-1",
        "OPENMAPX_ROOT_DIR",
        "PATH",
        "OPS_AGENT_HANDOFF_ID=handoff-1",
        "DOCKER_CONFIG=/tmp/docker",
      ]),
    );
    expect(args.filter((arg) => arg === "--mount")).toHaveLength(9);
    for (const role of ["ops-agent", "data-manager", "host-cli"])
      expect(args).toContain(
        `type=bind,source=/srv/openmapx/infra/docker/control-private/hidden-key,target=/srv/openmapx/infra/docker/secrets/control-${role}.key,readonly`,
      );
    expect(args).not.toContain("HOSTNAME");
    expect(args).not.toContain("DOCKER_CONFIG");
    // Only names: Docker copies each value from the agent's own environment.
    const env = args.flatMap((arg, index) => (args[index - 1] === "--env" ? [arg] : []));
    expect(env.filter((entry) => entry.includes("="))).toEqual([
      "DOCKER_CONFIG=/tmp/docker",
      "OPS_AGENT_HANDOFF_ID=handoff-1",
    ]);
    expect(args.slice(args.indexOf(oldImageId))).toEqual([
      oldImageId,
      "--",
      "node",
      "dist/agent-handoff-main.mjs",
    ]);
  });

  it("gives the helper an agent's narrow mounts as they are, read-only where the agent's are", () => {
    const args = agentHandoffRunArgs(narrow, "/srv/openmapx", "handoff-1");
    const mounts = args.flatMap((arg, index) => (args[index - 1] === "--mount" ? [arg] : []));
    expect(mounts).toEqual([
      "type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock",
      "type=bind,source=/srv/openmapx/infra/docker,target=/srv/openmapx/infra/docker,readonly",
      "type=bind,source=/srv/openmapx/infra/docker/state,target=/srv/openmapx/infra/docker/state",
      "type=bind,source=/srv/openmapx/infra/docker/data,target=/srv/openmapx/infra/docker/data",
      "type=bind,source=/srv/openmapx/infra/docker/secrets,target=/srv/openmapx/infra/docker/secrets",
      "type=bind,source=/srv/openmapx/infra/docker/backups,target=/srv/openmapx/infra/docker/backups",
      ...["ops-agent", "data-manager", "host-cli"].map(
        (role) =>
          `type=bind,source=/srv/openmapx/infra/docker/control-private/hidden-key,target=/srv/openmapx/infra/docker/secrets/control-${role}.key,readonly`,
      ),
      ...["data-manager", "host-cli"].map(
        (role) =>
          `type=bind,source=/srv/openmapx/infra/docker/control-private/empty,target=/srv/openmapx/infra/docker/control-private/${role},readonly`,
      ),
      "type=bind,source=/srv/openmapx/infra/docker/control-private/ops-agent,target=/var/lib/openmapx/control-private",
      "type=bind,source=/srv/openmapx/infra/docker/secrets/control-verifiers.json,target=/run/secrets/openmapx-control-verifiers,readonly",
    ]);
    expect(mounts.join("\n")).not.toContain("target=/srv/openmapx,");
  });

  it("rejects mount paths that would change the mount specification", () => {
    expect(() => agentHandoffRunArgs(facts, "/srv/open,mapx", "handoff-1")).toThrow();
    expect(() => agentHandoffRunArgs(facts, "/srv/openmapx", "../handoff")).toThrow();
    for (const mount of [
      { source: "/srv/open,mapx", target: "/srv/openmapx", readOnly: false },
      { source: "/srv/openmapx", target: "/elsewhere", readOnly: false },
    ]) {
      expect(() =>
        agentHandoffRunArgs({ ...facts, rootMounts: [mount] }, "/srv/openmapx", "handoff-1"),
      ).toThrow("Agent handoff rejected");
    }
    expect(() =>
      agentHandoffRunArgs({ ...facts, rootMounts: [] }, "/srv/openmapx", "handoff-1"),
    ).toThrow("Agent handoff rejected");
  });

  /** `docker container inspect` of an agent with these mounts. */
  const inspecting = (mounts: unknown[]) =>
    vi.fn(async (args: readonly string[]) => {
      const format = args[3];
      if (format === "{{.Image}}") return oldImageId;
      if (format === "{{.Config.User}}") return "1000:1000";
      if (format === "{{json .HostConfig.GroupAdd}}") return '["999"]';
      if (format?.includes(".Config.Env")) return "OPENMAPX_ROOT_DIR\nPATH\n";
      return JSON.stringify(mounts);
    });
  const socket = {
    Type: "bind",
    Source: "/run/docker.sock",
    Destination: "/var/run/docker.sock",
    RW: true,
  };
  const inspect = (mounts: unknown[]) =>
    inspectAgentContainer(
      inspecting(mounts),
      containerId,
      "/srv/openmapx",
      new AbortController().signal,
    );

  it("reads the agent's identity and the host sources of its mounts", async () => {
    await expect(
      inspect([
        socket,
        { Type: "bind", Source: "/srv/openmapx", Destination: "/srv/openmapx", RW: true },
        { Type: "bind", Source: "/root/.docker", Destination: "/home/node/.docker", RW: false },
      ]),
    ).resolves.toEqual({
      imageId: oldImageId,
      user: "1000:1000",
      groups: ["999"],
      envNames: ["OPENMAPX_ROOT_DIR", "PATH"],
      dockerSocketSource: "/run/docker.sock",
      rootMounts: [{ source: "/srv/openmapx", target: "/srv/openmapx", readOnly: false }],
    });
  });

  it("reads an agent's narrow mounts, outermost first, and nothing outside the checkout's path", async () => {
    const result = await inspect([
      socket,
      ...["backups", "state", "secrets", "data"].map((name) => ({
        Type: "bind",
        Source: `/srv/openmapx/infra/docker/${name}`,
        Destination: `/srv/openmapx/infra/docker/${name}`,
        RW: true,
      })),
      {
        Type: "bind",
        Source: "/srv/openmapx/infra/docker",
        Destination: "/srv/openmapx/infra/docker",
        RW: false,
      },
      {
        Type: "bind",
        Source: "/srv/openmapx/infra/docker/state/ops-agent/trusted-config",
        Destination: "/var/lib/openmapx/trusted-config",
        RW: true,
      },
    ]);
    expect(result.rootMounts[0]).toEqual({
      source: "/srv/openmapx/infra/docker",
      target: "/srv/openmapx/infra/docker",
      readOnly: true,
    });
    expect(result.rootMounts.map((mount) => mount.target).sort()).toEqual(
      ["", "/backups", "/data", "/secrets", "/state"].map(
        (name) => `/srv/openmapx/infra/docker${name}`,
      ),
    );
  });

  it("rejects an agent whose mounts give the helper no writable state or no .env", async () => {
    const infra = {
      Type: "bind",
      Source: "/srv/openmapx/infra/docker",
      Destination: "/srv/openmapx/infra/docker",
      RW: false,
    };
    const state = {
      Type: "bind",
      Source: "/srv/openmapx/infra/docker/state",
      Destination: "/srv/openmapx/infra/docker/state",
      RW: true,
    };
    for (const mounts of [
      [socket],
      [socket, infra],
      [socket, state],
      [socket, infra, { ...state, RW: false }],
      [socket, infra, { ...state, Type: "volume" }],
      [socket, { ...infra, Source: "/srv/open,mapx" }, state],
    ]) {
      await expect(inspect(mounts)).rejects.toThrow("Operations agent container rejected");
    }
    await expect(inspect([socket, infra, state])).resolves.toMatchObject({
      rootMounts: [
        { target: "/srv/openmapx/infra/docker", readOnly: true },
        { target: "/srv/openmapx/infra/docker/state", readOnly: false },
      ],
    });
  });
});
