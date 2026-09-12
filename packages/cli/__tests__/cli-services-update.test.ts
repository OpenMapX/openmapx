import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { registerServicesCommands } from "../src/commands/services";
import { dockerComposeStream } from "../src/lib/docker";
import { ensureReleaseOverlay } from "../src/lib/release";

// Preparation writes deployment files and hardlinks; isolate those effects and
// Docker while exercising the actual update command's release/error branches.
vi.mock("../src/commands/compose", () => ({
  renderComposeForRepo: vi.fn(async () => ({ selectionWarnings: [] })),
}));
vi.mock("../src/lib/hardlinks", () => ({
  applyGeneratedHardlinks: vi.fn(async () => ({ linked: 0, skipped: 0, pruned: 0 })),
}));
vi.mock("../src/lib/docker", () => ({ dockerComposeStream: vi.fn() }));
vi.mock("../src/lib/release", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/release")>()),
  ensureReleaseOverlay: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(dockerComposeStream).mockReset().mockResolvedValue(0);
  vi.mocked(ensureReleaseOverlay).mockReset();
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit:${code}`);
  });
});
afterEach(() => vi.restoreAllMocks());

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

  it("passes --no-deps only to recreation so an admin update cannot restart dependencies", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "present", path: "release.yml" });
    await expect(
      update("--no-deps", "data-manager", "app-web", "transitous-runner", "app-api"),
    ).rejects.toThrow("exit:0");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "data-manager", "app-web", "transitous-runner", "app-api"]],
      [
        [
          "up",
          "-d",
          "--force-recreate",
          "--no-deps",
          "data-manager",
          "app-web",
          "transitous-runner",
          "app-api",
        ],
      ],
    ]);
  });

  it("allows an explicitly unpinned local image after a failed pull", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({ status: "disabled" });
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("ops-agent")).rejects.toThrow("exit:0");
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "ops-agent"]],
      [["up", "-d", "--force-recreate", "ops-agent"]],
    ]);
  });

  it("does not pull or recreate when release resolution fails", async () => {
    vi.mocked(ensureReleaseOverlay).mockResolvedValue({
      status: "unpinned",
      reason: "unavailable",
    });
    await expect(update("ops-agent")).rejects.toThrow("exit:1");
    expect(dockerComposeStream).not.toHaveBeenCalled();
  });

  it("preserves locally built third-party service update behavior", async () => {
    vi.mocked(dockerComposeStream).mockResolvedValueOnce(7);
    await expect(update("valhalla")).rejects.toThrow("exit:0");
    expect(ensureReleaseOverlay).not.toHaveBeenCalled();
    expect(vi.mocked(dockerComposeStream).mock.calls).toEqual([
      [["pull", "valhalla"]],
      [["up", "-d", "--force-recreate", "valhalla"]],
    ]);
  });
});
