import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerCheckCommand } from "../src/commands/check";
import { dockerCompose } from "../src/lib/docker";
import { legacyTraefikDynamicMounted } from "../src/lib/legacy-traefik";
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
vi.mock("../src/lib/legacy-traefik", () => ({
  legacyTraefikDynamicMounted: vi.fn(async () => false),
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

it("says while Traefik still reads the checkout's routes, and which dynamic files are not copied", async () => {
  const dynamic = join(tmp, "services", "traefik", "config", "dynamic");
  mkdirSync(dynamic, { recursive: true });
  writeFileSync(join(tmp, "auth-elsewhere.yml"), "users: ['op:$2y$05$secret-hash']\n");
  symlinkSync(join(tmp, "auth-elsewhere.yml"), join(dynamic, "auth.yml"));
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
    expect.stringContaining(
      "services/traefik/config/dynamic/auth.yml was not copied to Traefik's dynamic directory, infra/docker/state/ops-agent/traefik/dynamic: it is a symbolic link.",
    ),
  ]);
  expect(traefikLines().join("\n")).not.toContain("secret-hash");

  // Quiet once Traefik is recreated and the file is a regular one.
  vi.mocked(legacyTraefikDynamicMounted).mockResolvedValue(false);
  rmSync(join(dynamic, "auth.yml"));
  writeFileSync(join(dynamic, "auth.yml"), "http: {}\n");
  errors.mockClear();
  await check();
  expect(traefikLines()).toEqual([]);
});
