import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { services } from "@openmapx/core/server";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..", "..");

function manifest(id: "api" | "ops-agent") {
  const directory = join(root, "services", id);
  return {
    directory,
    isBuiltIn: true,
    enabled: true,
    manifest: JSON.parse(readFileSync(join(directory, "service.json"), "utf8")),
  } as services.LoadedService;
}

describe("trusted configuration deployment handoff", () => {
  it("runs both ends as the deployment's user and shares no configuration directory", () => {
    const api = manifest("api");
    const agent = manifest("ops-agent");
    // Both run as UID:GID from .env, with no fallback uid: every render writes them.
    const user = `\${UID:?UID must be set, run pnpm openmapx compose render}:\${GID:?GID must be set, run pnpm openmapx compose render}`;
    expect(api.manifest.container.user).toBe(user);
    expect(agent.manifest.container.user).toBe(user);
    // The payload travels in the authenticated request; the API mounts no
    // part of the agent's state but the integrations it loads.
    const apiAgentState = (api.manifest.bindMounts ?? [])
      .map((mount) => mount.source)
      .filter((source) => source.startsWith("@infra:state/ops-agent"));
    expect(apiAgentState).toEqual(["@infra:state/ops-agent/custom-integrations"]);
    expect(
      Object.keys(api.manifest.container.environment ?? {}).filter((key) =>
        key.startsWith("OPS_TRUSTED_CONFIG"),
      ),
    ).toEqual([]);
  });
});
