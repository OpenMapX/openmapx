import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { describeServiceFilesAtStart } from "./service-files-at-start";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function stack() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-agent-start-"));
  roots.push(root);
  const infraDir = join(root, "infra", "docker");
  mkdirSync(infraDir, { recursive: true });
  const directory = join(root, "services", "martin");
  mkdirSync(join(directory, "config"), { recursive: true });
  writeFileSync(join(directory, "config", "martin.yaml"), "listen_addresses: 0.0.0.0:3000\n");
  const martin: services.LoadedService = {
    manifest: {
      id: "martin",
      name: "martin",
      version: "1.0.0",
      quality: "built-in",
      container: { image: "example/martin", tag: "1" },
      bindMounts: [{ source: "config/martin.yaml", target: "/etc/martin/martin.yaml" }],
    },
    directory,
    isBuiltIn: true,
    enabled: true,
  };
  const checkout = services.releaseServiceFiles([martin]);
  const release: services.ReleaseServiceFiles = { ...checkout, origin: "release" };
  return { infraDir, martin, release };
}

const input = (selectedRoots: string[]) => ({
  domain: "maps.example.test",
  selectedRoots,
  serviceConfigs: [],
  integrationConfigs: [],
  serviceSecrets: [],
});

describe("the agent's start after a panel self-update", () => {
  it("starts from its predecessor's generation, which records no service files, and says the next render takes the release's", async () => {
    const f = stack();
    // The generation an earlier release rendered: its services mount the checkout.
    await services.commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: [f.martin],
      input: input(["martin"]),
      legacyTraefikDynamicMounted: false,
    });
    const revision = services.currentConfigurationGeneration(f.infraDir) as string;
    const generation = join(f.infraDir, services.CONFIGURATION_GENERATIONS, revision);
    rmSync(join(generation, "service-files.json"));
    const lines = describeServiceFilesAtStart(f.infraDir, f.release);
    expect(lines).toEqual([
      "The applied configuration was rendered by an earlier release, whose services mount their files from the checkout. The next render mounts this release's files instead.",
      "The next render imports, once, your edits in the checkout's service files as overrides in infra/docker/overrides/services.",
    ]);

    // The update's own render: the import first, then the release's files.
    const committed = await services.commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: [f.martin],
      input: input(["martin"]),
      releaseServiceFiles: f.release,
      legacyTraefikDynamicMounted: false,
    });
    expect(committed.serviceFileReport).toEqual([]);
    expect(services.serviceFilesImported(f.infraDir)).toBe(true);
    const compose = readFileSync(
      join(f.infraDir, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      "utf8",
    );
    expect(compose).toMatch(
      /\.\.\/\.\.\/service-files\/martin\/[a-f0-9]{64}\/config\/martin\.yaml/,
    );
    expect(describeServiceFilesAtStart(f.infraDir, f.release)).toEqual([]);
  });

  it("reports an override it may not use instead of failing to start", () => {
    const f = stack();
    const override = join(f.infraDir, "overrides", "services", "martin", "config", "martin.yaml");
    mkdirSync(join(override, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(override, "x: 1\n");
    chmodSync(override, 0o666);
    expect(describeServiceFilesAtStart(f.infraDir, f.release)).toEqual([
      expect.stringContaining("The next render imports, once"),
      expect.stringContaining(
        "infra/docker/overrides/services/martin/config/martin.yaml can't be used: group or others may write it",
      ),
    ]);
  });
});
