import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCheckCommand } from "../src/commands/check";
import { legacyTraefikDynamicMounted } from "../src/lib/container-mounts";
import { selectedReleaseServiceFiles } from "../src/lib/release-service-files";

// The check stops at its first Docker call; what it reported before that is
// what this test reads.
vi.mock("../src/lib/docker", () => ({
  dockerCompose: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "no Docker in this test" })),
  dockerRun: vi.fn(),
}));
vi.mock("../src/lib/container-mounts", () => ({
  legacyTraefikDynamicMounted: vi.fn(async () => false),
}));
// No release is selected unless a test selects one.
vi.mock("../src/lib/release-service-files", () => ({
  selectedReleaseServiceFiles: vi.fn(async () => "none"),
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-check-command-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker"), { recursive: true });
  vi.stubEnv("OPENMAPX_ROOT_DIR", tmp);
  vi.stubEnv("POSTGRES_PASSWORD", "x".repeat(24));
  vi.stubEnv("POSTGRES_USER", "postgres");
  vi.stubEnv("BETTER_AUTH_SECRET", "a".repeat(32));
  vi.stubEnv("DATA_MANAGER_AUTH_TOKEN", "b".repeat(32));
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

it("says while Traefik still reads the checkout's routes", async () => {
  vi.mocked(legacyTraefikDynamicMounted).mockResolvedValue(true);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const check = async () => {
    const program = new Command();
    registerCheckCommand(program);
    await expect(program.parseAsync(["check"], { from: "user" })).rejects.toThrow("exit:1");
  };
  const traefikLines = () =>
    errors.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes("Traefik"));

  await check();
  expect(traefikLines()).toEqual([
    expect.stringContaining(
      "Traefik still reads its routes from services/traefik/config/dynamic, where render keeps writing them until no container mounts that directory. Recreate Traefik to move it to infra/docker/state/ops-agent/traefik/dynamic: pnpm openmapx services update traefik, or Recreate on Admin → Services → Traefik. That restarts the proxy for a few seconds.",
    ),
  ]);

  // Quiet once Traefik is recreated.
  vi.mocked(legacyTraefikDynamicMounted).mockResolvedValue(false);
  errors.mockClear();
  await check();
  expect(traefikLines()).toEqual([]);
});

it("reports the service files: the overrides in use and a host render's refusal", async () => {
  const directory = join(tmp, "services", "martin");
  mkdirSync(join(directory, "config"), { recursive: true });
  const manifest = {
    id: "martin",
    name: "martin",
    version: "1.0.0",
    quality: "built-in",
    container: { image: "example/martin", tag: "1" },
    bindMounts: [{ source: "config/martin.yaml", target: "/etc/martin/martin.yaml" }],
  };
  writeFileSync(join(directory, "service.json"), JSON.stringify(manifest));
  writeFileSync(join(directory, "config", "martin.yaml"), "listen_addresses: 0.0.0.0:3000\n");
  const override = join(tmp, "infra", "docker", "overrides", "services", "martin", "config");
  mkdirSync(override, { recursive: true, mode: 0o755 });
  writeFileSync(join(override, "martin.yaml"), "users: ['op:$2y$05$secret-hash']\n");
  // Whatever the umask: overrides group or others may write are refused.
  chmodSync(join(override, "martin.yaml"), 0o644);
  const checkout = services.releaseServiceFiles([
    { manifest, directory, isBuiltIn: true, enabled: true } as services.LoadedService,
  ]);
  vi.mocked(selectedReleaseServiceFiles).mockResolvedValue({
    files: { ...checkout, origin: "release", manifests: new Map([["martin", "0".repeat(64)]]) },
    release: "r1",
    image: "ghcr.io/openmapx/ops-agent@sha256:1",
    revision: "a".repeat(40),
  });
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  // log.info: stdout, which Run diagnostics shows as information.
  const infos = vi.spyOn(console, "log").mockImplementation(() => {});
  const check = async () => {
    const program = new Command();
    registerCheckCommand(program);
    await expect(program.parseAsync(["check"], { from: "user" })).rejects.toThrow("exit:1");
  };
  const lines = () => errors.mock.calls.flat().map(String);
  try {
    // A changed checkout file without an override: a host render refuses it.
    writeFileSync(join(directory, "config", "martin.yaml"), "listen_addresses: 0.0.0.0:3001\n");
    rmSync(join(override, "martin.yaml"));
    await check();
    expect(lines()).toContainEqual(
      expect.stringContaining(
        "A host render refuses until this is resolved. The checkout's built-in services differ from the selected release r1",
      ),
    );
    expect(lines()).toContainEqual(
      expect.stringContaining("services/martin/config/martin.yaml (changed)"),
    );
    writeFileSync(join(directory, "config", "martin.yaml"), "listen_addresses: 0.0.0.0:3000\n");
    writeFileSync(join(override, "martin.yaml"), "users: ['op:$2y$05$secret-hash']\n");
    chmodSync(join(override, "martin.yaml"), 0o644);
    errors.mockClear();
    infos.mockClear();

    await check();
    // How things are, with nothing to do: information, on stdout, without ⚠.
    const information = infos.mock.calls.flat().map(String);
    expect(information).toContainEqual(
      "Service file overrides in use, in place of the release's files (infra/docker/overrides/services): martin/config/martin.yaml.",
    );
    expect(lines().join("\n")).not.toContain("Service file overrides in use");
    // The overridden file is not a difference; the manifest the release doesn't have is.
    expect(lines().join("\n")).not.toContain("services/martin/config/martin.yaml");
    expect(lines()).toContainEqual(
      expect.stringContaining("services/martin/service.json (changed)"),
    );
    expect([...lines(), ...information].join("\n")).not.toContain("secret-hash");
  } finally {
    vi.mocked(selectedReleaseServiceFiles).mockResolvedValue("none");
  }
});
