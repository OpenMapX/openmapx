import { readFileSync } from "node:fs";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");

function manifest(id: "app-api" | "ops-agent") {
  const directory = join(root, "services", id);
  return {
    directory,
    isBuiltIn: true,
    enabled: true,
    manifest: JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
  } as services.LoadedService;
}

describe("trusted configuration deployment handoff", () => {
  it("uses one narrow confidential host queue for root API and configurable non-root agent", () => {
    const api = manifest("app-api");
    const agent = manifest("ops-agent");
    expect(api.manifest.container.user).toBeUndefined();
    expect(agent.manifest.container.user).toBe("${UID:-1000}:${GID:-1000}");
    for (const service of [api, agent]) {
      expect(service.manifest.container.environment?.OPS_TRUSTED_CONFIG_DIR).toBe(
        "/var/lib/openmapx/trusted-config",
      );
      expect(service.manifest.bindMounts).toContainEqual({
        source: "@infra:data/ops-agent/trusted-config",
        target: "/var/lib/openmapx/trusted-config",
        readOnly: false,
      });
    }
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_UID).toBe("${UID:-1000}");
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_GID).toBe("${GID:-1000}");
  });

  it("renders the queue against the real infra root through the generation pointer", () => {
    const rendered = services.renderCompose([manifest("ops-agent")], {
      composeOutDir: join(root, "infra", "docker", ".trusted-config-current"),
      infraDir: join(root, "infra", "docker"),
      allServices: [manifest("ops-agent")],
    });
    expect(rendered.composeYaml).toContain(
      "../data/ops-agent/trusted-config:/var/lib/openmapx/trusted-config",
    );
    expect(rendered.composeYaml).not.toContain(".trusted-config-current/data/ops-agent");
  });
});
