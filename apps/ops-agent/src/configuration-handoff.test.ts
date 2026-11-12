import { CONFIGURATION_RELEASE_IMAGE_NAMES } from "@openmapx/core/ops";
import { describe, expect, it, vi } from "vitest";
import {
  type AgentContainerFacts,
  configurationHandoffRunArgs,
  configurationHandoffServiceOrder,
  inspectAgentContainer,
  inspectConfigurationHandoffPrerequisite,
} from "./configuration-handoff";
import { observeConfigurationHandoffReleaseImage } from "./configuration-handoff-application";

const handoffId = "11111111-1111-4111-8111-111111111111",
  image = `sha256:${"a".repeat(64)}`;
const facts = {
  imageId: image,
  user: "1000:1000",
  groups: ["10"],
  envNames: [
    "HOME",
    "OPS_CONFIGURATION_HANDOFF_ID",
    "OPENMAPX_CONTROL_EXECUTION",
    "OPENMAPX_CONTROL_DELEGATION",
    "DOCKER_CONFIG",
  ],
  dockerSocketSource: "/var/run/docker.sock",
  rootMounts: [{ source: "/synthetic/host", target: "/synthetic/host", readOnly: false }],
};
it("launches the existing confined old-image helper with only original control references", () => {
  const args = configurationHandoffRunArgs(facts, "/synthetic/host", {
    handoffId,
    assertion: "original-signed-assertion",
    execution: {
      executor: "host-cli",
      principal: "api",
      executionId: "22222222-2222-4222-8222-222222222222",
      operationKey: "opk1_helperoriginaladdress",
      operationFingerprint: "b".repeat(64),
      fingerprint: "c".repeat(64),
      deadlineAt: Date.now() + 60000,
    },
  });
  expect(args[args.indexOf("--name") + 1]).toBe(`openmapx-configuration-handoff-${handoffId}`);
  expect(args).toContain("dist/configuration-handoff-main.mjs");
  expect(args).toContain(image);
  expect(args).toContain("--read-only");
  expect(args.join(" ")).toContain("control-private/hidden-key");
  expect(args.join(" ")).toContain("control-private/empty");
  expect(args.filter((a) => a.startsWith("OPENMAPX_CONTROL_DELEGATION="))).toHaveLength(1);
  expect(args.filter((a) => a.startsWith("OPS_CONFIGURATION_HANDOFF_ID="))).toEqual([
    `OPS_CONFIGURATION_HANDOFF_ID=${handoffId}`,
  ]);
  expect(args).not.toContain("OPS_CONFIGURATION_HANDOFF_ID");
  expect(args.filter((value) => value.startsWith("OPENMAPX_ROOT_DIR="))).toEqual([
    "OPENMAPX_ROOT_DIR=/synthetic/host",
  ]);
});
describe("configuration helper container", () => {
  const execution = {
    executor: "host-cli" as const,
    principal: "api" as const,
    executionId: "22222222-2222-4222-8222-222222222222",
    operationKey: "opk1_helperoriginaladdress",
    operationFingerprint: "b".repeat(64),
    fingerprint: "c".repeat(64),
    deadlineAt: Date.now() + 60000,
  };
  const launch = (agent: AgentContainerFacts, rootDir = "/srv/openmapx", id = handoffId) =>
    configurationHandoffRunArgs(agent, rootDir, {
      handoffId: id,
      assertion: "signed-assertion",
      execution,
    });
  const agent: AgentContainerFacts = {
    imageId: image,
    user: "1000:1000",
    groups: ["999"],
    envNames: ["PATH", "HOSTNAME", "DOCKER_CONFIG", "OPENMAPX_ROOT_DIR"],
    dockerSocketSource: "/var/run/docker.sock",
    rootMounts: [{ source: "/srv/openmapx", target: "/srv/openmapx", readOnly: false }],
  };
  const narrow: AgentContainerFacts = {
    ...agent,
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
    const args = launch(agent);
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
        `openmapx.configuration-handoff=${handoffId}`,
        "PATH",
      ]),
    );
    expect(args.filter((arg) => arg === "--mount")).toHaveLength(9);
    for (const role of ["ops-agent", "data-manager", "host-cli"])
      expect(args).toContain(
        `type=bind,source=/srv/openmapx/infra/docker/control-private/hidden-key,target=/srv/openmapx/infra/docker/secrets/control-${role}.key,readonly`,
      );
    // Only names: Docker copies each value from the agent's own environment.
    const env = args.flatMap((arg, index) => (args[index - 1] === "--env" ? [arg] : []));
    expect(env).toEqual([
      "PATH",
      "DOCKER_CONFIG=/tmp/docker",
      "OPENMAPX_ROOT_DIR=/srv/openmapx",
      `OPS_CONFIGURATION_HANDOFF_ID=${handoffId}`,
      "OPENMAPX_CONTROL_DELEGATION=signed-assertion",
      `OPENMAPX_CONTROL_EXECUTION=${JSON.stringify(execution)}`,
    ]);
    expect(args.slice(args.indexOf("--workdir"))).toEqual([
      "--workdir",
      "/app/apps/ops-agent",
      "--entrypoint",
      "/sbin/tini",
      image,
      "--",
      "node",
      "dist/configuration-handoff-main.mjs",
    ]);
  });

  it("gives the helper an agent's narrow mounts as they are, read-only where the agent's are", () => {
    const args = launch(narrow);
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
    expect(() => launch(agent, "/srv/open,mapx")).toThrow();
    expect(() => launch(agent, "/srv/openmapx", "../handoff")).toThrow();
    for (const mount of [
      { source: "/srv/open,mapx", target: "/srv/openmapx", readOnly: false },
      { source: "/srv/openmapx", target: "/elsewhere", readOnly: false },
    ]) {
      expect(() => launch({ ...agent, rootMounts: [mount] })).toThrow(
        "Configuration helper launch rejected",
      );
    }
    expect(() => launch({ ...agent, rootMounts: [] })).toThrow(
      "Configuration helper launch rejected",
    );
  });

  /** `docker container inspect` of an agent with these mounts. */
  const inspecting = (mounts: unknown[]) =>
    vi.fn(async (args: readonly string[]) => {
      const format = args[3];
      if (format === "{{.Image}}") return image;
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
      "c".repeat(64),
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
      imageId: image,
      user: "1000:1000",
      groups: ["999"],
      envNames: ["OPENMAPX_ROOT_DIR", "PATH"],
      dockerSocketSource: "/run/docker.sock",
      rootMounts: [{ source: "/srv/openmapx", target: "/srv/openmapx", readOnly: false }],
    });
  });

  it("reads an agent's narrow mounts, outermost first, and nothing outside the root's path", async () => {
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

it("orders dependencies and the agent last without silently expanding frozen targets", () => {
  expect(
    configurationHandoffServiceOrder([
      "ops-agent",
      "traefik",
      "app-api",
      "redis",
      "postgis",
      "app-web",
    ]),
  ).toEqual(["postgis", "redis", "app-web", "app-api", "traefik", "ops-agent"]);
  expect(
    configurationHandoffServiceOrder(["motis", "app-api", "data-manager", "ops-agent"]),
  ).toEqual(["data-manager", "motis", "app-api", "ops-agent"]);
  expect(() => configurationHandoffServiceOrder(["app-api", "app-api"])).toThrow();
});
it("requires the actual old image's helper version before any launch", async () => {
  const calls: string[][] = [];
  const run = async (args: readonly string[]) => {
    calls.push([...args]);
    const format = args[args.indexOf("--format") + 1];
    if (args[0] === "image") return "";
    if (format === "{{.Image}}") return image;
    if (format === "{{.Config.User}}") return "1000:1000";
    if (format === "{{json .HostConfig.GroupAdd}}") return "[]";
    if (format?.includes("range .Config.Env")) return "HOME\n";
    if (format === "{{json .Mounts}}")
      return JSON.stringify([
        { Destination: "/var/run/docker.sock", Source: "/var/run/docker.sock" },
        { Destination: "/synthetic/host", Source: "/synthetic/host" },
      ]);
    throw Error("Unexpected Docker read");
  };
  await expect(
    inspectConfigurationHandoffPrerequisite({
      runDocker: run,
      containerId: "c".repeat(64),
      imageId: image,
      rootDir: "/synthetic/host",
      signal: new AbortController().signal,
    }),
  ).rejects.toMatchObject({ name: "OpsHostUpdateRequiredError" });
  expect(calls.every((args) => args.includes("inspect"))).toBe(true);
});

it("does not let observations or terminal preparations indefinitely block replacement", async () => {
  const { configurationHandoffBlocksReplacement } = await import("./configuration-handoff");
  expect(configurationHandoffBlocksReplacement("service.logs.follow", "running")).toBe(false);
  expect(configurationHandoffBlocksReplacement("system.diagnostics", "running")).toBe(false);
  expect(configurationHandoffBlocksReplacement("service.start", "running")).toBe(true);
  expect(configurationHandoffBlocksReplacement("service.start", "termination_pending")).toBe(true);
  expect(configurationHandoffBlocksReplacement("service.start", "succeeded")).toBe(false);
});

it("uses actual server job state when excluding a live log observer from drain", async () => {
  const { buildOpsAgentServer } = await import("./server");
  const api = Buffer.alloc(32, 31).toString("base64url"),
    dm = Buffer.alloc(32, 32).toString("base64url");
  const logging = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>(),
    checked = Promise.withResolvers<number>();
  const app = buildOpsAgentServer({
    tokens: { api, "data-manager": dm },
    resourcePolicy: { allowGlobal: () => true, allowService: () => true },
    dispatch: async (operation, _runtime, context) => {
      if (operation.kind === "service.logs.follow") {
        logging.resolve();
        await release.promise;
        return { lines: 0, truncated: false };
      }
      checked.resolve(context.otherActiveOperations?.() ?? -1);
      return { ok: true, checks: [] };
    },
  });
  const baseUrl = await app.listen({ host: "127.0.0.1", port: 0 });
  const send = async (operation: Record<string, unknown>, suffix: string) => {
    const response = await fetch(`${baseUrl}/v1/operations`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${api}`,
        "x-ops-protocol-version": "2",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        version: 2,
        requestId: `ops1_observation${suffix}`,
        operationKey: `opk1_observation${suffix}`,
        issuedAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 15000).toISOString(),
        execution: { requestedDeadlineAt: Date.now() + 60000 },
        operation,
      }),
    });
    return { statusCode: response.status, body: await response.json() };
  };
  try {
    const logResponse = await send(
      { kind: "service.logs.follow", serviceId: "motis", tail: 1, maxDurationSeconds: 60 },
      "logs0000",
    );
    expect(logResponse.statusCode, JSON.stringify(logResponse.body)).toBe(202);
    await logging.promise;
    const diagnosticResponse = await send({ kind: "system.diagnostics" }, "diag0000");
    expect(diagnosticResponse.statusCode, JSON.stringify(diagnosticResponse.body)).toBe(202);
    expect(await checked.promise).toBe(0);
  } finally {
    release.resolve();
    await app.close();
  }
});

it("rejects a handoff DTO without the actual borrowed original owner", async () => {
  const { assertOwnedMaintenanceHandoffRuntime } = await import(
    "./configuration-maintenance-store"
  );
  const { createUnavailableRuntime } = await import("./runtime");
  const { testExecution } = await import("./__fixtures__/execution");
  const operation = {
    kind: "configurationHandoff.prepare" as const,
    handoffId,
    maintenanceId: "22222222-2222-4222-8222-222222222222",
    candidateId: "33333333-3333-4333-8333-333333333333",
    planDigest: "a".repeat(64),
    previewFingerprint: "b".repeat(64),
    serviceIds: ["ops-agent"],
    expectedCurrentRevisionId: `cfg1_${"c".repeat(43)}`,
    expectedImageIdentities: { "ops-agent": image },
    mode: { kind: "configuration" as const },
  };
  await expect(
    assertOwnedMaintenanceHandoffRuntime(createUnavailableRuntime(), operation, {
      execution: testExecution(),
      signal: new AbortController().signal,
      emitLog: () => {},
      claim: {
        operation,
        fingerprint: "a".repeat(64),
        source: "registry",
        capability: { revisionId: "registry1", values: {} },
      },
    }),
  ).rejects.toThrow("Actual original borrowed maintenance handoff required");
});

const pinnedDigest = `sha256:${"a".repeat(64)}`,
  localImageId = `sha256:${"d".repeat(64)}`;
const releaseDownloads = {
  version: 1 as const,
  platform: "linux/amd64" as const,
  declaredBytes: CONFIGURATION_RELEASE_IMAGE_NAMES.length,
  images: CONFIGURATION_RELEASE_IMAGE_NAMES.map((name) => ({
    image: name,
    reference: `ghcr.io/openmapx/${name}@${pinnedDigest}`,
    platformManifestDigest: `sha256:${"b".repeat(64)}`,
    configDigest: `sha256:${"c".repeat(64)}`,
    declaredBytes: 1,
  })),
};
function localDocker(image: Record<string, unknown> | "missing") {
  return vi.fn(async (_file: string, args: readonly string[]) => {
    if (args[0] === "image" && args[1] === "inspect") {
      if (image === "missing") throw Error("No such image");
      return {
        stdout: JSON.stringify({
          Id: localImageId,
          RepoDigests: [args[4]],
          Os: "linux",
          Architecture: "amd64",
          ...image,
        }),
        stderr: "",
      };
    }
    throw Error(`Unexpected Docker call: ${args.join(" ")}`);
  });
}
const observe = (execFile: ReturnType<typeof localDocker>) =>
  observeConfigurationHandoffReleaseImage({
    downloads: releaseDownloads,
    image: "api",
    execFile,
    signal: new AbortController().signal,
  });
it("the helper does not pull an image already present with the expected id", async () => {
  const execFile = localDocker({});
  await expect(observe(execFile)).resolves.toEqual({ imageId: localImageId });
  expect(execFile.mock.calls.map(([, args]) => args.slice(0, 2))).toEqual([["image", "inspect"]]);
});
it.each([
  ["missing", "missing" as const],
  ["a different digest", { RepoDigests: [`ghcr.io/openmapx/api@sha256:${"e".repeat(64)}`] }],
  ["a different platform", { Architecture: "arm64" }],
])("the helper fails before recreate if an image is %s", async (_label, local) => {
  const execFile = localDocker(local);
  await expect(observe(execFile)).rejects.toThrow();
  // Nothing is downloaded once maintenance has begun, so a registry outage can
  // no longer strand the instance.
  expect(execFile.mock.calls.some(([, args]) => args.includes("pull"))).toBe(false);
});
