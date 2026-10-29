import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { services as coreServices } from "@openmapx/core/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { narrowAgentLayoutBlockers, refuseUnreadyAgentSwitch } from "../src/lib/agent-layout";
import { containerBindMounts } from "../src/lib/container-mounts";
import { ensureTransitousApiKeysFile, transitousApiKeysPath } from "../src/lib/transitous-api-keys";

vi.mock("../src/lib/container-mounts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/container-mounts")>()),
  containerBindMounts: vi.fn(async () => []),
}));

const REPO = resolve(import.meta.dirname, "..", "..", "..");
const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const input = {
  domain: "maps.example.test",
  selectedRoots: ["ops-agent"],
  serviceConfigs: [],
  integrationConfigs: [],
  serviceSecrets: [],
};

function opsAgent(root: string): coreServices.LoadedService {
  return {
    manifest: JSON.parse(readFileSync(join(REPO, "services/ops-agent/service.json"), "utf8")),
    directory: join(root, "services", "ops-agent"),
    isBuiltIn: true,
    enabled: true,
  };
}

/** A host where nothing the switch needs is missing, with the agent on the whole checkout. */
async function readyHost() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-layout-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(join(root, "services", "ops-agent"), { recursive: true });
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(infraDir, "state", "ops-agent"), { recursive: true, mode: 0o700 });
  const owner = statSync(root);
  writeFileSync(join(infraDir, ".env"), `UID=${owner.uid}\nGID=${owner.gid}\n`, { mode: 0o600 });
  writeFileSync(
    join(infraDir, "state/ops-agent/overrides-import.json"),
    `${JSON.stringify({ version: 1, importedAt: "2026-10-26T00:00:00Z", imported: [] })}\n`,
    { mode: 0o600 },
  );
  coreServices.prepareAgentStores(infraDir);
  coreServices.retireLegacyConfigurationWriter(infraDir);
  ensureTransitousApiKeysFile(root);
  await coreServices.commitConfigurationGeneration({
    infraDir,
    services: [opsAgent(root)],
    input,
  });
  return { root, infraDir };
}

describe("the switch of the operations agent to its narrow mounts", () => {
  it("needs nothing more on a host that has everything", async () => {
    const { root } = await readyHost();
    expect(narrowAgentLayoutBlockers({ rootDir: root, mounts: [] })).toEqual([]);
  });

  const missing: Array<[string, (host: { root: string; infraDir: string }) => void, RegExp]> = [
    [
      "UID and GID in .env",
      ({ infraDir }) => writeFileSync(join(infraDir, ".env"), "DOMAIN=x\n", { mode: 0o600 }),
      /^infra\/docker\/\.env sets no UID or GID, .*pnpm openmapx compose render/,
    ],
    [
      "the one-time import",
      ({ infraDir }) => rmSync(join(infraDir, "state/ops-agent/overrides-import.json")),
      /^The one-time import .*overrides-import\.json is missing.*pnpm openmapx compose release/,
    ],
    [
      "the stores' copy",
      ({ infraDir }) => rmSync(join(infraDir, "state/ops-agent/stores-migration.json")),
      /stores-migration\.json is missing\): render again\.$/,
    ],
    [
      "the retired earlier lock",
      ({ infraDir }) =>
        rmSync(join(infraDir, "state/ops-agent/legacy-configuration-writer-retired.json")),
      /legacy-configuration-writer-retired\.json is missing\): start this release's operations agent/,
    ],
    [
      "the Transitous keys",
      ({ infraDir }) => rmSync(transitousApiKeysPath(infraDir)),
      /^The Transitous API keys .*api-keys\.json is missing\): render again\.$/,
    ],
    [
      "the earlier release state",
      ({ infraDir }) => mkdirSync(join(infraDir, ".ops-agent-releases")),
      /^The earlier release's release state in infra\/docker has not been carried/,
    ],
    [
      "an applied generation",
      ({ infraDir }) =>
        rmSync(join(infraDir, "state/ops-agent/configuration"), { recursive: true }),
      /^No configuration generation is applied yet/,
    ],
  ];
  it.each(missing)("waits for %s, and says how to get it", async (_name, remove, message) => {
    const host = await readyHost();
    remove(host);
    expect(narrowAgentLayoutBlockers({ rootDir: host.root, mounts: [] })).toEqual([
      expect.stringMatching(message),
    ]);
  });

  it("waits while any container mounts the checkout's services/, Traefik's dynamic directory included", async () => {
    const { root } = await readyHost();
    const mounts = [
      // The agent itself, on the whole checkout, is what the switch replaces.
      { name: "openmapx-ops-agent-1", sources: [root] },
      { name: "openmapx-traefik-1", sources: [join(root, "services/traefik/config/dynamic")] },
      { name: "openmapx-martin-1", sources: [join(root, "services/martin/config/martin.yaml")] },
    ];
    expect(narrowAgentLayoutBlockers({ rootDir: root, mounts })).toEqual([
      expect.stringMatching(
        /^openmapx-martin-1, openmapx-traefik-1 still mount files from the checkout's services\/.*pnpm openmapx services update <service>/,
      ),
    ]);
    expect(narrowAgentLayoutBlockers({ rootDir: root, mounts: undefined })).toEqual([
      expect.stringMatching(/^Docker could not list the containers' mounts/),
    ]);
  });
});

describe("a host command that would recreate the operations agent", () => {
  async function narrowGeneration() {
    const host = await readyHost();
    await coreServices.commitConfigurationGeneration({
      infraDir: host.infraDir,
      services: [opsAgent(host.root)],
      input,
      agentMountLayout: () => "narrow",
    });
    vi.stubEnv("OPENMAPX_ROOT_DIR", host.root);
    return host;
  }

  it("switches it when nothing is missing, and leaves an agent already without the checkout", async () => {
    const { root } = await narrowGeneration();
    vi.mocked(containerBindMounts).mockResolvedValue([
      { name: "openmapx-ops-agent-1", sources: [root] },
    ]);
    await expect(refuseUnreadyAgentSwitch(["ops-agent"])).resolves.toBeUndefined();
    vi.mocked(containerBindMounts).mockResolvedValue([
      { name: "openmapx-ops-agent-1", sources: [join(root, "infra/docker")] },
    ]);
    await expect(refuseUnreadyAgentSwitch("all")).resolves.toBeUndefined();
  });

  it("is refused, naming what is missing, before the switch could half happen", async () => {
    const { root, infraDir } = await narrowGeneration();
    rmSync(join(infraDir, "state/ops-agent/legacy-configuration-writer-retired.json"));
    vi.mocked(containerBindMounts).mockResolvedValue([
      { name: "openmapx-ops-agent-1", sources: [root] },
    ]);
    await expect(refuseUnreadyAgentSwitch(["app-api", "ops-agent"])).rejects.toThrow(
      /^The operations agent is not recreated with its narrow mounts\. The operations agent keeps the whole checkout mounted\..*\n- Writers still take the earlier releases' configuration lock/s,
    );
    // Commands that don't recreate the agent, and generations that keep the
    // whole checkout, are not asked.
    await expect(refuseUnreadyAgentSwitch(["app-api"])).resolves.toBeUndefined();
    await coreServices.commitConfigurationGeneration({
      infraDir,
      services: [opsAgent(root)],
      input,
    });
    await expect(refuseUnreadyAgentSwitch("all")).resolves.toBeUndefined();
  });
});
