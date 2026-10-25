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
  it("uses one narrow confidential host queue, which the API and the agent both use as the deployment's user", () => {
    const api = manifest("app-api");
    const agent = manifest("ops-agent");
    // Both run as UID:GID from .env, with no fallback uid: every render writes them.
    const user = `\${UID:?UID must be set, run pnpm openmapx compose render}:\${GID:?GID must be set, run pnpm openmapx compose render}`;
    expect(api.manifest.container.user).toBe(user);
    expect(agent.manifest.container.user).toBe(user);
    for (const service of [api, agent]) {
      expect(service.manifest.container.environment?.OPS_TRUSTED_CONFIG_DIR).toBe(
        "/var/lib/openmapx/trusted-config",
      );
      expect(service.manifest.bindMounts).toContainEqual({
        source: "@infra:state/ops-agent/trusted-config",
        target: "/var/lib/openmapx/trusted-config",
        readOnly: false,
      });
    }
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_UID).toBe(
      `\${UID:?UID must be set, run pnpm openmapx compose render}`,
    );
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_GID).toBe(
      `\${GID:?GID must be set, run pnpm openmapx compose render}`,
    );
  });

  it("renders the queue against the real infra root through the generation pointer", () => {
    const rendered = services.renderCompose([manifest("ops-agent")], {
      composeOutDir: join(root, "infra", "docker", services.CURRENT_CONFIGURATION),
      infraDir: join(root, "infra", "docker"),
      allServices: [manifest("ops-agent")],
    });
    expect(rendered.composeYaml).toContain("../../trusted-config:/var/lib/openmapx/trusted-config");
    expect(rendered.composeYaml).not.toContain("current/state/ops-agent");
  });
});
