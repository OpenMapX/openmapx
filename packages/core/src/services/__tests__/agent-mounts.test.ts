import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { load as parseYaml } from "js-yaml";
import { afterEach, describe, expect, it } from "vitest";
import {
  agentBindMounts,
  generationAgentMountLayout,
  WHOLE_CHECKOUT_AGENT_MOUNT,
} from "../agent-mounts";
import { renderCompose } from "../compose-renderer";
import { commitConfigurationGeneration } from "../configuration-generation";
import type { LoadedService, ServiceManifest } from "../types";

const REPO = resolve(import.meta.dirname, "..", "..", "..", "..", "..");
const manifest = JSON.parse(
  readFileSync(join(REPO, "services", "ops-agent", "service.json"), "utf8"),
) as ServiceManifest;

const roots: string[] = [];
it("keeps managed catalog metadata writable under the narrow agent layout", () => {
  const mount = agentBindMounts(agent("/srv/openmapx"), "narrow").find((entry) =>
    entry.target.endsWith("/infra/docker/catalog-pins"),
  );
  expect(mount).toMatchObject({ readOnly: false });
});
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function agent(root: string): LoadedService {
  return {
    manifest: structuredClone(manifest),
    directory: join(root, "services", "ops-agent"),
    isBuiltIn: true,
    enabled: true,
  };
}

/** The agent's rendered bind volumes at the checkout's path. */
function atCheckoutPath(volumes: readonly string[]): string[] {
  return volumes.filter((volume) => volume.startsWith("${OPENMAPX_HOST_DIR"));
}

/** After the source's variable: the rest of each source, and the target Compose substitutes. */
const NARROW = [
  // biome-ignore lint/suspicious/noTemplateCurlyInString: Compose substitutes this, as in the manifest
  "/infra/docker:${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set}/infra/docker:ro",
  ...["state", "data", "secrets", "backups", "catalog-pins"].map(
    (name) =>
      `/infra/docker/${name}:\${OPENMAPX_HOST_DIR:?OPENMAPX_HOST_DIR must be set}/infra/docker/${name}`,
  ),
];

describe("the operations agent's mounts", () => {
  it("are infra/docker read-only and its runtime directories in the manifest, and nothing else of the checkout", () => {
    const volumes =
      (
        parseYaml(
          renderCompose([agent("/srv/openmapx")], { infraDir: "/srv/openmapx/infra/docker" })
            .composeYaml,
        ) as {
          services: Record<string, { volumes: string[] }>;
        }
      ).services["ops-agent"]?.volumes ?? [];
    expect(atCheckoutPath(volumes).map((volume) => volume.replace(/^\$\{[^}]*\}/, ""))).toEqual(
      NARROW,
    );
  });

  it("render the whole checkout in their place in the checkout layout, and leave the others", () => {
    const service = agent("/srv/openmapx");
    const narrow = agentBindMounts(service, "narrow");
    const whole = agentBindMounts(service, "checkout");
    expect(narrow).toEqual(manifest.bindMounts);
    const others = (manifest.bindMounts ?? []).filter(
      (mount) => !mount.source.startsWith("${OPENMAPX_HOST_DIR"),
    );
    expect(whole.filter((mount) => mount !== WHOLE_CHECKOUT_AGENT_MOUNT)).toEqual(others);
    expect(whole.filter((mount) => mount === WHOLE_CHECKOUT_AGENT_MOUNT)).toHaveLength(1);
    // A service that is not the built-in agent renders as declared.
    const community = { ...service, isBuiltIn: false };
    expect(agentBindMounts(community, "checkout")).toEqual(manifest.bindMounts);
  });

  it("keep the layout of the agent that renders them, unless a render on the host chooses", async () => {
    const input = {
      domain: "maps.example.test",
      selectedRoots: ["ops-agent"],
      serviceConfigs: [],
      integrationConfigs: [],
      serviceSecrets: [],
    };
    const host = (layout: "checkout" | "narrow") => {
      const root = mkdtempSync(join(tmpdir(), `openmapx-agent-mounts-${layout}-`));
      roots.push(root);
      if (layout === "checkout")
        mkdirSync(join(root, "services", "ops-agent"), { recursive: true });
      const infraDir = join(root, "infra", "docker");
      mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
      return { root, infraDir };
    };
    // The agent with the whole checkout keeps it.
    const checkout = host("checkout");
    await commitConfigurationGeneration({
      infraDir: checkout.infraDir,
      services: [agent(checkout.root)],
      input,
    });
    expect(generationAgentMountLayout(checkout.infraDir)).toBe("checkout");
    // The agent without the checkout keeps that.
    const narrow = host("narrow");
    await commitConfigurationGeneration({
      infraDir: narrow.infraDir,
      services: [agent(narrow.root)],
      input,
    });
    expect(generationAgentMountLayout(narrow.infraDir)).toBe("narrow");
    // A render on the host chooses, after the one-time import.
    let asked = 0;
    await commitConfigurationGeneration({
      infraDir: checkout.infraDir,
      services: [agent(checkout.root)],
      input,
      agentMountLayout: () => {
        asked += 1;
        return "narrow";
      },
    });
    expect(asked).toBe(1);
    expect(generationAgentMountLayout(checkout.infraDir)).toBe("narrow");
  });

  it("are unknown without a generation", () => {
    const root = mkdtempSync(join(tmpdir(), "openmapx-agent-mounts-none-"));
    roots.push(root);
    expect(generationAgentMountLayout(join(root, "infra", "docker"))).toBeNull();
  });
});
