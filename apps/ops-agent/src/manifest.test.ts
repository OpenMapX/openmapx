import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderServiceSnippet, ServiceRegistry } from "../../../packages/core/src/services";

const root = join(__dirname, "..", "..", "..");

describe("ops-agent deployment manifest", () => {
  it("renders only on the private platform network with no proxy or host port", async () => {
    const registry = new ServiceRegistry({ rootDir: root });
    await registry.load();
    const selected = registry
      .list()
      .filter((service) => ["ops-agent", "app-api", "data-manager"].includes(service.manifest.id));
    const loadedOps = selected.find((service) => service.manifest.id === "ops-agent");
    expect(loadedOps).toBeDefined();
    if (!loadedOps) throw new Error("ops-agent manifest was not loaded");
    const ops = renderServiceSnippet(loadedOps, {
      domain: "example.com",
      allServices: registry.list(),
      composeOutDir: join(root, "infra", "docker"),
    });
    expect(ops.expose).toEqual(["4300"]);
    expect(ops.networks).toEqual(["openmapx"]);
    expect(ops.group_add).toEqual([expect.stringContaining("DOCKER_GID:?DOCKER_GID must be set")]);
    expect(ops).not.toHaveProperty("ports");
    expect(ops).not.toHaveProperty("labels");
  });

  it("mounts matching caller credentials and both verifier files without raw bearer env", () => {
    const load = (id: string) =>
      JSON.parse(readFileSync(join(root, "services", id, "service.json"), "utf8")) as {
        container: { environment?: Record<string, string> };
        bindMounts?: Array<{ source: string; target: string; readOnly?: boolean }>;
        exposure?: unknown;
      };
    const api = load("app-api");
    const dataManager = load("data-manager");
    const ops = load("ops-agent");
    expect(api.container.environment?.OPS_AGENT_TOKEN_FILE).toBe(
      "/run/secrets/ops-agent-api-token",
    );
    expect(dataManager.container.environment?.OPS_AGENT_TOKEN_FILE).toBe(
      "/run/secrets/ops-agent-data-manager-token",
    );
    expect(api.container.environment).not.toHaveProperty("OPS_AGENT_TOKEN");
    expect(dataManager.container.environment).not.toHaveProperty("OPS_AGENT_TOKEN");
    expect(api.bindMounts?.filter((mount) => mount.source.includes("ops-agent-"))).toEqual([
      expect.objectContaining({ source: "@infra:secrets/ops-agent-api-token", readOnly: true }),
    ]);
    expect(dataManager.bindMounts?.filter((mount) => mount.source.includes("ops-agent-"))).toEqual([
      expect.objectContaining({
        source: "@infra:secrets/ops-agent-data-manager-token",
        readOnly: true,
      }),
    ]);
    expect(ops.bindMounts?.filter((mount) => mount.source.includes("ops-agent-"))).toHaveLength(2);
    expect(ops.exposure).toBeUndefined();
    expect(ops.container.environment?.OPENMAPX_ENABLED_SERVICES).toBe(
      "${OPENMAPX_ENABLED_SERVICES:-traefik,well-known,app-api,app-web,postgis,redis,data-manager}",
    );
  });

  it("leaves Docker authority with the operations agent alone", () => {
    const socketFor = (id: string) => {
      const manifest = JSON.parse(
        readFileSync(join(root, "services", id, "service.json"), "utf8"),
      ) as { bindMounts?: Array<{ source: string }> };
      return manifest.bindMounts?.some((mount) => mount.source === "@docker-socket") === true;
    };

    // Every caller now requests host effects as typed agent operations, so the
    // operations agent is the only component that holds Docker authority.
    for (const id of ["traefik", "data-manager", "app-api"]) {
      expect(socketFor(id), `${id} must not hold a Docker socket`).toBe(false);
    }
    expect(socketFor("ops-agent")).toBe(true);
  });
});
