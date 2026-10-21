import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../community-repositories", () => ({ readCommunityServices: vi.fn() }));

import { readCommunityServices } from "../community-repositories";

const readMock = vi.mocked(readCommunityServices);

let tmp: string;
let originalCwd: string;
let originalAgentUrl: string | undefined;

function communityService(id: string, repository: string) {
  return {
    repository,
    directory: `/srv/openmapx/services/.community/${repository}/${id}`,
    manifest: {
      id,
      name: id,
      version: "1.0.0",
      quality: "community",
      container: {
        image: `registry.example.test/${id}`,
        tag: "1.0.0",
        digest: `sha256:${"c".repeat(64)}`,
      },
    },
  };
}

function snapshot(services: ReturnType<typeof communityService>[], problems: string[] = []) {
  return {
    revisionId: `cfg1_${"d".repeat(43)}`,
    repositories: [],
    services,
    problems,
  } as never;
}

async function loadRegistry() {
  vi.resetModules();
  return import("../service-registry.js");
}

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.OPENMAPX_ENABLED_SERVICES;
  delete process.env.OPENMAPX_APPLIED_SERVICES;
  originalAgentUrl = process.env.OPS_AGENT_URL;
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "openmapx-api-community-registry-"));
  mkdirSync(join(tmp, "apps", "api"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  process.chdir(join(tmp, "apps", "api"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  process.chdir(originalCwd);
  rmSync(tmp, { recursive: true, force: true });
  if (originalAgentUrl === undefined) delete process.env.OPS_AGENT_URL;
  else process.env.OPS_AGENT_URL = originalAgentUrl;
});

describe("community services in the API registry", () => {
  it("lists the services the operations agent reports, with their repository", async () => {
    process.env.OPS_AGENT_URL = "http://ops-agent:8787";
    readMock.mockResolvedValueOnce(
      snapshot([communityService("svc-one", "1".repeat(16))], ["svc-two was rejected"]),
    );
    const registry = await loadRegistry();

    await registry.initServiceRegistry();

    const service = registry.getServiceRegistry().get("svc-one");
    expect(service).toMatchObject({ isBuiltIn: false });
    expect(registry.communityServiceRepository("svc-one")).toBe("1".repeat(16));
    expect(registry.getServiceRegistryWarnings()).toContain("svc-two was rejected");
  });

  it("keeps the last reported services while the agent is unreachable and retries", async () => {
    process.env.OPS_AGENT_URL = "http://ops-agent:8787";
    readMock.mockResolvedValueOnce(snapshot([communityService("svc-one", "1".repeat(16))]));
    const registry = await loadRegistry();
    await registry.initServiceRegistry();

    readMock.mockRejectedValueOnce(new Error("unreachable"));
    await registry.initServiceRegistry();

    expect(registry.getServiceRegistry().get("svc-one")).toBeDefined();
    expect(registry.getServiceRegistryWarnings()).toContain(
      "The operations agent is unreachable; community services are shown as last reported.",
    );

    readMock.mockResolvedValueOnce(snapshot([communityService("svc-two", "2".repeat(16))]));
    await vi.advanceTimersByTimeAsync(60_000);

    expect(readMock).toHaveBeenCalledTimes(3);
    expect(registry.getServiceRegistry().get("svc-one")).toBeUndefined();
    expect(registry.communityServiceRepository("svc-two")).toBe("2".repeat(16));
  });

  it("scans the checkout instead when no operations agent is configured", async () => {
    delete process.env.OPS_AGENT_URL;
    const directory = join(tmp, "services", ".community", "1".repeat(16), "svc-local");
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "service.json"),
      JSON.stringify(communityService("svc-local", "1".repeat(16)).manifest),
    );
    const registry = await loadRegistry();

    await registry.initServiceRegistry();

    expect(readMock).not.toHaveBeenCalled();
    expect(registry.getServiceRegistry().get("svc-local")).toMatchObject({ isBuiltIn: false });
  });
});
