import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { afterEach, describe, expect, it } from "vitest";
import { agentLogLine, describeServiceFilesAtStart } from "./service-files-at-start";

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

describe("the agent's start", () => {
  it("says nothing about the release's own files, and names the overrides in use as information", async () => {
    const f = stack();
    const committed = await services.commitConfigurationGeneration({
      infraDir: f.infraDir,
      services: [f.martin],
      input: input(["martin"]),
      releaseServiceFiles: f.release,
      legacyTraefikDynamicMounted: false,
    });
    expect(committed.serviceFileReport).toEqual([]);
    // Services mount the files from the agent's store, not from the checkout.
    const compose = readFileSync(
      join(f.infraDir, services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
      "utf8",
    );
    expect(compose).toMatch(
      /\.\.\/\.\.\/service-files\/martin\/[a-f0-9]{64}\/config\/martin\.yaml/,
    );
    expect(describeServiceFilesAtStart(f.infraDir, f.release)).toEqual([]);

    const override = join(f.infraDir, "overrides", "services", "martin", "config", "martin.yaml");
    mkdirSync(join(override, ".."), { recursive: true, mode: 0o755 });
    // Whatever the umask: overrides group or others may write are refused.
    const overrides = join(f.infraDir, "overrides");
    for (const path of ["", "services", "services/martin", "services/martin/config"]) {
      chmodSync(join(overrides, path), 0o755);
    }
    writeFileSync(override, "x: 1\n");
    chmodSync(override, 0o644);
    const lines = describeServiceFilesAtStart(f.infraDir, f.release);
    expect(lines).toEqual([
      {
        level: "info",
        message:
          "Service file overrides in use, in place of the release's files (infra/docker/overrides/services): martin/config/martin.yaml.",
      },
    ]);
    // The agent's log has it as is; a warning would start with ⚠.
    expect(lines.map(agentLogLine)).toEqual(lines.map((line) => line.message));
  });

  it("says nothing under OPENMAPX_RELEASE=local, where there is no release to report against", () => {
    expect(describeServiceFilesAtStart(stack().infraDir, null)).toEqual([]);
  });

  it("reports an override it may not use instead of failing to start", () => {
    const f = stack();
    const override = join(f.infraDir, "overrides", "services", "martin", "config", "martin.yaml");
    mkdirSync(join(override, ".."), { recursive: true, mode: 0o755 });
    writeFileSync(override, "x: 1\n");
    chmodSync(override, 0o666);
    const lines = describeServiceFilesAtStart(f.infraDir, f.release);
    expect(lines).toEqual([
      {
        level: "warn",
        message: expect.stringContaining(
          "infra/docker/overrides/services/martin/config/martin.yaml can't be used: group or others may write it",
        ),
      },
    ]);
    expect(agentLogLine(lines[0] as services.ServiceFileReportLine)).toMatch(/^⚠ /);
  });
});
