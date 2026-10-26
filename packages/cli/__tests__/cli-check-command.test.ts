import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCheckCommand } from "../src/commands/check";
import { containerBindMounts, legacyTraefikDynamicMounted } from "../src/lib/container-mounts";
import { dockerCompose } from "../src/lib/docker";
import { selectedReleaseServiceFiles } from "../src/lib/release-service-files";
import {
  ensureTransitousApiKeysFile,
  legacyTransitousApiKeysPath,
} from "../src/lib/transitous-api-keys";

// The check stops at its first Docker call; what it reported before that is
// what this test reads.
vi.mock("../src/lib/docker", () => ({
  dockerCompose: vi.fn(async () => ({ exitCode: 1, stdout: "", stderr: "no Docker in this test" })),
  dockerRun: vi.fn(),
}));
vi.mock("../src/lib/container-mounts", () => ({
  legacyTraefikDynamicMounted: vi.fn(async () => false),
  containerBindMounts: vi.fn(async () => []),
}));
// No release is selected unless a test selects one.
vi.mock("../src/lib/release-service-files", () => ({
  selectedReleaseServiceFiles: vi.fn(async () => "none"),
}));

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-check-command-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services", "motis", "tools", "transitous"), { recursive: true });
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

it("reports Transitous keys a refused copy left behind on every check", async () => {
  const legacy = legacyTransitousApiKeysPath(tmp);
  writeFileSync(legacy, JSON.stringify({ "de/BVG": "secret-value" }));
  chmodSync(legacy, 0o664);
  ensureTransitousApiKeysFile(tmp);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});

  for (let run = 0; run < 2; run++) {
    const program = new Command();
    registerCheckCommand(program);
    await expect(program.parseAsync(["check"], { from: "user" })).rejects.toThrow("exit:1");
  }

  const reported = errors.mock.calls
    .flat()
    .map(String)
    .filter((line) => line.includes("Transitous API keys"));
  expect(reported).toHaveLength(2);
  expect(reported[0]).toContain(
    "sets 1 key that infra/docker/secrets/transitous-api-keys/api-keys.json doesn't (de/BVG): it was not copied because group or others can write it.",
  );
  expect(reported.join("\n")).not.toContain("secret-value");
  expect(vi.mocked(dockerCompose)).toHaveBeenCalled();
});

it("reports what the copy of the agent's stores left in the checkout while it is there", async () => {
  mkdirSync(join(tmp, "custom_integrations", "hand-placed"), { recursive: true });
  services.prepareAgentStores(join(tmp, "infra", "docker"));
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const check = async () => {
    const program = new Command();
    registerCheckCommand(program);
    await expect(program.parseAsync(["check"], { from: "user" })).rejects.toThrow("exit:1");
  };
  const leftBehind = () =>
    errors.mock.calls
      .flat()
      .map(String)
      .filter((line) => line.includes("was not copied into the operations agent's state"));

  await check();
  await check();
  expect(leftBehind()).toEqual([
    expect.stringContaining(
      "The integration hand-placed in custom_integrations was not copied into the operations agent's state: the agent holds no record of it.",
    ),
    expect.stringContaining("The integration hand-placed in custom_integrations"),
  ]);

  // Gone once the operator deletes it.
  rmSync(join(tmp, "custom_integrations", "hand-placed"), { recursive: true });
  errors.mockClear();
  await check();
  expect(leftBehind()).toEqual([]);
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

it("reports the service files: overrides, the import to come, a host render's refusal, containers on the checkout", async () => {
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
  vi.mocked(containerBindMounts).mockResolvedValue([
    { name: "docker-martin-1", sources: [join(directory, "config", "martin.yaml")] },
  ]);
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const check = async () => {
    const program = new Command();
    registerCheckCommand(program);
    await expect(program.parseAsync(["check"], { from: "user" })).rejects.toThrow("exit:1");
  };
  const lines = () => errors.mock.calls.flat().map(String);
  try {
    await check();
    expect(lines()).toContainEqual(expect.stringContaining("The next render imports, once"));
    expect(lines()).toContainEqual(
      expect.stringContaining(
        "Service file overrides in use, in place of the release's files (infra/docker/overrides/services): martin/config/martin.yaml.",
      ),
    );
    expect(lines()).toContainEqual(
      expect.stringContaining(
        "1 container still mounts service files from the checkout: docker-martin-1.",
      ),
    );
    expect(lines().join("\n")).not.toContain("secret-hash");

    // Once the import ran: what a host render would refuse.
    services.importCheckoutServiceFiles({
      infraDir: join(tmp, "infra", "docker"),
      services: [],
      release: { ...checkout, origin: "release" },
    });
    errors.mockClear();
    await check();
    expect(lines()).toContainEqual(
      expect.stringContaining(
        "A host render refuses until this is resolved. The checkout's built-in services differ from the selected release r1",
      ),
    );
    expect(lines()).toContainEqual(
      expect.stringContaining("services/martin/service.json (changed)"),
    );
  } finally {
    vi.mocked(selectedReleaseServiceFiles).mockResolvedValue("none");
    vi.mocked(containerBindMounts).mockResolvedValue([]);
  }
});
