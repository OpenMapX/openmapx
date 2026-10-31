import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { services } from "@openmapx/core/server";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import { renderComposeForRepo, renderComposeWithWriter } from "../src/commands/compose";
import { registerServicesCommands } from "../src/commands/services";
import { refuseAgentSwitchOrExit } from "../src/lib/agent-layout";
import { dockerComposeStream } from "../src/lib/docker";
import { ensureReleaseOverlay } from "../src/lib/release";

vi.setConfig({ testTimeout: 60000 });

// Named external Docker/registry edges. Commands, files, renderer, locks and receipts are real.
// Whether recreating the agent would switch it to its narrow mounts unready
// is agent-layout.test.ts's; here it lets the update go on.
vi.mock("../src/lib/agent-layout", async (original) => ({
  ...(await original<typeof import("../src/lib/agent-layout")>()),
  refuseAgentSwitchOrExit: vi.fn(async () => {}),
}));
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

vi.mock("../src/lib/release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/release")>()),
  ensureReleaseOverlay: vi.fn(),
}));

let root: string, seed: string;
beforeEach(async () => {
  vi.mocked(renderComposeWithWriter).mockReset();
  root = mkdtempSync(join(tmpdir(), "omx-cli-update-"));
  writeFileSync(join(root, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(root, "infra/docker"), { recursive: true });
  const ids = ["ops-agent", "transitous-runner", "data-manager", "app-web", "app-api", "valhalla"];
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
    DATA_MANAGER_AUTH_TOKEN: "d".repeat(32),
  }))
    vi.stubEnv(key, value);
  services.writeServiceSelectionFile(join(root, "infra/docker"), ids);
  seed = (await renderComposeForRepo({ rootDir: root, domain: "example.test" })).revisionId;
  vi.mocked(dockerComposeStream).mockReset().mockResolvedValue(0);
  vi.mocked(ensureReleaseOverlay).mockReset();
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
  it.each(["present", "resolved"] as const)(
    "stops before recreation when a %s release cannot be pulled",
    async (status) => {
      vi.mocked(ensureReleaseOverlay).mockResolvedValue({
        status,
        path: "release.yml",
        release: "abc",
      });
      vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
      await expect(update("ops-agent", "transitous-runner")).rejects.toThrow("exit:7");
      expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
        [["pull", "ops-agent", "transitous-runner"]],
      ]);
    },
  );

  it("recreates a pinned release after a successful pull", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "present", path: "release.yml" });
    await expect(update("ops-agent")).rejects.toThrow("exit:0");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "ops-agent"]],
      [["up", "-d", "--force-recreate", "ops-agent"]],
    ]);
  });

  it("passes --no-deps only to ordinary target recreation", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "present", path: "release.yml" });
    await expect(update("--no-deps", "app-web", "transitous-runner", "app-api")).rejects.toThrow(
      "exit:0",
    );
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "app-api", "app-web", "transitous-runner"]],
      [["up", "-d", "--force-recreate", "--no-deps", "app-api", "app-web", "transitous-runner"]],
    ]);
  });

  it("refuses an explicitly unpinned local image after a failed pull", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "disabled" });
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("ops-agent")).rejects.toThrow("exit:7");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "ops-agent"]]]);
  });

  it("does not pull or recreate when release resolution fails", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({
      status: "unpinned",
      reason: "unavailable",
    });
    await expect(update("ops-agent")).rejects.toThrow("exit:1");
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("refuses recreation of a locally built service after a failed pull", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("valhalla")).rejects.toThrow("exit:7");
    expect(ensureReleaseOverlay).not.toHaveBeenCalled();
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "valhalla"]]]);
  });
  it("validates pins and pulls before full generation preparation, hardlinks and recreation", async () => {
    const events: string[] = [];
    vi.mocked(ensureReleaseOverlay).mockImplementation(async () => {
      events.push("pins");
      return { status: "present", path: "release.yml" };
    });
    vi.mocked(dockerComposeStream).mockImplementation(async (args) => {
      const current = services.currentConfigurationGeneration(join(root, "infra/docker"));
      if (args[0] === "pull") {
        expect(current).toBe(seed);
        events.push("pull");
      } else {
        expect(current).not.toBe(seed);
        const directory = join(root, "infra/docker/data/ops-agent/lifecycle");
        const raw = JSON.parse(readFileSync(join(directory, readdirSync(directory)[0]!), "utf8"));
        const receipt = await services.readServiceLifecycleReceipt({
          dataRoot: join(root, "infra/docker/data"),
          execution: raw.current.payload.receipt.execution,
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
    expect(events).toEqual(["pins", "pull", "recreate"]);
  });
});

describe("services update and the operations agent's mounts", () => {
  it("does not recreate when rendering after the pull cannot resolve the deployment user", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "present", path: "release.yml" });
    vi.mocked(renderComposeWithWriter).mockRejectedValueOnce(
      new Error(
        "The checkout /srv/openmapx is owned by root, so the deployment's user cannot be taken from it: set UID and GID in /srv/openmapx/infra/docker/.env to the account that runs the stack",
      ),
    );
    await expect(update("ops-agent")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "ops-agent"]]]);
    expect(renderComposeWithWriter).toHaveBeenCalled();
    expect(refuseAgentSwitchOrExit).not.toHaveBeenCalled();
  });

  it("asks before it could recreate the agent, and recreates nothing when the switch isn't ready", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "present", path: "release.yml" });
    await expect(update("--no-deps", "app-api")).rejects.toThrow("exit:0");
    expect(refuseAgentSwitchOrExit).toHaveBeenLastCalledWith(["app-api"]);
    await expect(update("app-api")).rejects.toThrow("exit:0");
    expect(refuseAgentSwitchOrExit).toHaveBeenLastCalledWith("all");

    vi.mocked(dockerComposeStream).mockClear();
    vi.mocked(refuseAgentSwitchOrExit).mockImplementationOnce(async () => {
      throw new Error("exit:1");
    });
    await expect(update("ops-agent")).rejects.toThrow("exit:1");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([[["pull", "ops-agent"]]]);
  });
});
