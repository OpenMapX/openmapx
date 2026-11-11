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
    // The agent opens the queue and its privacy scratch through the checkout,
    // so only app-api mounts the queue and is told where it is.
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_DIR).toBe(
      "/var/lib/openmapx/trusted-config",
    );
    expect(agent.manifest.container.environment).not.toHaveProperty("OPS_TRUSTED_CONFIG_DIR");
    expect(api.manifest.bindMounts).toContainEqual({
      source: "@infra:state/ops-agent/trusted-config",
      target: "/var/lib/openmapx/trusted-config",
      readOnly: false,
    });
    const agentSources = (agent.manifest.bindMounts ?? []).map((mount) => mount.source);
    expect(agentSources).not.toContain("@infra:state/ops-agent/trusted-config");
    expect(agentSources).not.toContain("@infra:state/ops-agent/privacy-extraction");
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_UID).toBe(
      `\${UID:?UID must be set, run pnpm openmapx compose render}`,
    );
    expect(api.manifest.container.environment?.OPS_TRUSTED_CONFIG_GID).toBe(
      `\${GID:?GID must be set, run pnpm openmapx compose render}`,
    );
  });

  it("renders the queue against the real infra root through the generation pointer", () => {
    const rendered = services.renderCompose([manifest("app-api")], {
      composeOutDir: join(root, "infra", "docker", services.CURRENT_CONFIGURATION),
      infraDir: join(root, "infra", "docker"),
      allServices: [manifest("app-api")],
    });
    expect(rendered.composeYaml).toContain("../../trusted-config:/var/lib/openmapx/trusted-config");
    expect(rendered.composeYaml).not.toContain("current/state/ops-agent");
  });
});
