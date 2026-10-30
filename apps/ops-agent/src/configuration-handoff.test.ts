import { expect, it } from "vitest";
import {
  configurationHandoffRunArgs,
  configurationHandoffServiceOrder,
  inspectConfigurationHandoffPrerequisite,
} from "./configuration-handoff";

const handoffId = "11111111-1111-4111-8111-111111111111",
  image = `sha256:${"a".repeat(64)}`;
const facts = {
  imageId: image,
  user: "1000:1000",
  groups: ["10"],
  envNames: [
    "HOME",
    "OPS_AGENT_HANDOFF_ID",
    "OPS_CONFIGURATION_HANDOFF_ID",
    "OPENMAPX_CONTROL_EXECUTION",
    "OPENMAPX_CONTROL_DELEGATION",
    "DOCKER_CONFIG",
  ],
  dockerSocketSource: "/var/run/docker.sock",
  rootSource: "/synthetic/host",
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
  expect(args).not.toContain("OPS_AGENT_HANDOFF_ID");
  expect(args).not.toContain("OPS_CONFIGURATION_HANDOFF_ID");
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
