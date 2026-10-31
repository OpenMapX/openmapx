import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDataCommands } from "../src/commands/data";
import { runCliDataStep } from "../src/lib/data-execution";

// Command presentation/result-policy unit boundary. Durable POST/GET identity,
// signed containment and SQL ownership belong to the real execution suites.
vi.mock("../src/lib/data-execution", () => ({ runCliDataStep: vi.fn() }));

function program() {
  const command = new Command();
  command.exitOverride();
  registerDataCommands(command);
  return command;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(runCliDataStep).mockReset();
});

describe("data-manager CLI result policy", () => {
  it("exits unsuccessfully for an unsuccessful durable conflation completion", async () => {
    vi.mocked(runCliDataStep).mockRejectedValueOnce(
      new Error("Data execution original-id finished error"),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      program().parseAsync(["data", "overture-conflate", "europe/germany"], { from: "user" }),
    ).rejects.toThrow("exit:1");
    expect(vi.mocked(runCliDataStep).mock.calls[0]?.[0]).toEqual({
      kind: "overture-conflate",
      region: "europe/germany",
      restart: false,
    });
    expect(errors.mock.calls.flat().join(" ")).toContain(
      "Data execution original-id finished error",
    );
    expect(output.mock.calls.flat().join(" ")).not.toContain("conflation complete");
  });
  it("does not announce downloaded fonts when the durable command rejects a malformed response", async () => {
    vi.mocked(runCliDataStep).mockRejectedValueOnce(
      new Error("data-manager response contract failed"),
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit:${code}`);
    });
    await expect(
      program().parseAsync(["data", "download", "fonts"], { from: "user" }),
    ).rejects.toThrow("exit:1");
    expect(vi.mocked(runCliDataStep).mock.calls[0]?.[0]).toEqual({ kind: "download-fonts" });
    expect(errors.mock.calls.flat().join(" ")).toContain("response contract failed");
    expect(output.mock.calls.flat().join(" ")).not.toContain("Downloaded map glyphs");
  });
});
