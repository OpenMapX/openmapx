import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderComposeForRepo, renderComposeWithWriter } from "../src/commands/compose";
import { registerServicesCommands } from "../src/commands/services";
import { migrateBeforeApiUpdate } from "../src/lib/api-migrations";
import { dockerComposeStream } from "../src/lib/docker";

vi.setConfig({ testTimeout: 60000 });

// Named external Docker/registry edges. Commands, files, renderer, locks and receipts are real.
vi.mock("../src/commands/compose", async (original) => {
  const actual = await original<typeof import("../src/commands/compose")>();
  return { ...actual, renderComposeWithWriter: vi.fn(actual.renderComposeWithWriter) };
});
vi.mock("../src/lib/docker", async (original) => {
  const actual = await original<typeof import("../src/lib/docker")>();
  return {
    ...actual,
    dockerComposeStream: vi.fn(),
    // Native Compose's JSON inspection edge, over the actual generated model.
    dockerCompose: vi.fn(async (args: string[], rootDir?: string) => {
      if (args.join(" ") !== "config --format json") return actual.dockerCompose(args, rootDir);
      const yaml = readFileSync(
        join(root, "infra/docker", services.CURRENT_CONFIGURATION, "docker-compose.generated.yml"),
        "utf8",
      );
      return { exitCode: 0, stderr: "", stdout: JSON.stringify(parseYaml(yaml)) };
    }),
  };
});

// The migration step's own Docker calls are api-migrations.test.ts's.
vi.mock("../src/lib/api-migrations", () => ({
  API_SERVICE_ID: "api",
  migrateBeforeApiUpdate: vi.fn(async () => 0),
}));

let root: string, seed: string;
beforeEach(async () => {
  vi.mocked(renderComposeWithWriter).mockReset();
  root = mkdtempSync(join(tmpdir(), "omx-cli-update-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  const ids = ["ops-agent", "transitous-runner", "data-manager", "web", "api", "valhalla"];
  for (const id of ids) {
    const directory = join(root, "services", id);
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, "service.json"),
      JSON.stringify({
        id,
        name: id,
        version: "1.0.0",
        quality: "built-in",
        container: { image: `fixture/${id}`, tag: "1" },
      }),
    );
  }
  for (const [key, value] of Object.entries({
    OPENMAPX_ROOT_DIR: root,
    OPENMAPX_RELEASE: "local",
    DOMAIN: "example.test",
    OPENMAPX_ENABLED_SERVICES: "",
    POSTGRES_PASSWORD: "p".repeat(24),
    BETTER_AUTH_SECRET: "a".repeat(32),
  }))
    vi.stubEnv(key, value);
  services.writeServiceSelectionFile(join(root, "infra/docker"), ids);
  seed = (await renderComposeForRepo({ rootDir: root, domain: "example.test" })).revisionId;
  vi.mocked(dockerComposeStream).mockReset().mockResolvedValue(0);
  vi.mocked(migrateBeforeApiUpdate).mockReset().mockResolvedValue(0);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

function update(...ids: string[]) {
  const program = new Command();
  registerServicesCommands(program);
  return program.parseAsync(["services", "update", ...ids], { from: "user" });
}

describe("services update pull failures", () => {
  it("stops before recreation when a release cannot be pulled", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("ops-agent", "transitous-runner")).rejects.toThrow("exit:7");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "ops-agent", "transitous-runner"]],
    ]);
  });

  it("recreates a pinned release after a successful pull", async () => {
    await expect(update("ops-agent")).rejects.toThrow("exit:0");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "ops-agent"]],
      [["up", "-d", "--force-recreate", "ops-agent"]],
    ]);
  });

  it("passes --no-deps only to ordinary target recreation", async () => {
    await expect(update("--no-deps", "web", "transitous-runner", "api")).rejects.toThrow("exit:0");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "api", "transitous-runner", "web"]],
      [["up", "-d", "--force-recreate", "--no-deps", "api", "transitous-runner", "web"]],
    ]);
  });

  it("refuses an explicitly unpinned local image after a failed pull", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("ops-agent")).rejects.toThrow("exit:7");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "ops-agent"]]]);
  });

  it("does not pull or recreate release images the applied configuration does not pin", async () => {
    vi.stubEnv("OPENMAPX_RELEASE", "main");
    await expect(update("ops-agent")).rejects.toThrow("exit:1");
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("refuses recreation of a locally built service after a failed pull", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("valhalla")).rejects.toThrow("exit:7");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "valhalla"]]]);
  });
  it("pulls before full generation preparation, hardlinks and recreation", async () => {
    const events: string[] = [];
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      const current = services.currentConfigurationGeneration(join(root, "infra/docker"));
      if (args[0] === "pull") {
        expect(current).toBe(seed);
        events.push("pull");
      } else {
        expect(current).not.toBe(seed);
        const directory = join(root, "infra/docker/state/ops-agent/lifecycle");
        const [envelopeName] = readdirSync(directory);
        assert.isDefined(envelopeName);
        const raw = JSON.parse(readFileSync(join(directory, envelopeName), "utf8"));
        const receipt = await services.readServiceLifecycleReceipt({
          dataRoot: join(root, "infra/docker/data"),
          execution: raw.current.receipt.execution,
        });
        expect(receipt).toMatchObject({
          phase: "hardlinks_applied",
          finalRevisionId: current,
          hardlinks: { applied: true, entries: 0 },
        });
        events.push("recreate");
      }
      return 0;
    });
    await expect(update("ops-agent")).rejects.toThrow("exit:0");
    expect(events).toEqual(["pull", "recreate"]);
  });
});

describe("services update and the operations agent", () => {
  it("does not recreate when rendering after the pull cannot resolve the deployment user", async () => {
    vi.mocked(renderComposeWithWriter).mockRejectedValueOnce(
      new Error(
        "The checkout /srv/openmapx is owned by root, so the deployment's user cannot be taken from it: set UID and GID in /srv/openmapx/infra/docker/.env to the account that runs the stack",
      ),
    );
    await expect(update("ops-agent")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "ops-agent"]]]);
    expect(renderComposeWithWriter).toHaveBeenCalled();
  });
});

describe("services update and the API's database migrations", () => {
  it("migrates after the pull and before recreation when the API is replaced", async () => {
    const order: string[] = [];
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      const [command] = args;
      assert.isDefined(command, "docker compose was called without a command");
      order.push(command);
      return 0;
    });
    vi.mocked(migrateBeforeApiUpdate).mockImplementation(async () => {
      order.push("migrate");
      return 0;
    });
    await expect(update("--no-deps", "web", "api")).rejects.toThrow("exit:0");
    expect(order).toEqual(["pull", "migrate", "up"]);
    expect(migrateBeforeApiUpdate).toHaveBeenCalledWith({ deps: false });

    await expect(update("api")).rejects.toThrow("exit:0");
    expect(migrateBeforeApiUpdate).toHaveBeenLastCalledWith({ deps: true });
  });

  it("recreates nothing when the migration step fails", async () => {
    vi.mocked(migrateBeforeApiUpdate).mockResolvedValue(1);
    await expect(update("--no-deps", "web", "api")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "api", "web"]]]);
  });

  it("does not migrate when the API is not among the services", async () => {
    await expect(update("web")).rejects.toThrow("exit:0");
    expect(migrateBeforeApiUpdate).not.toHaveBeenCalled();
  });
});
