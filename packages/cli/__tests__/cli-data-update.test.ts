import { Command } from "commander";
import { expect, it, vi } from "vitest";

const f = vi.hoisted(() => ({ update: vi.fn(), ok: vi.fn() }));
vi.mock("../src/lib/data-update-command", () => ({ runCliDataUpdate: f.update }));
vi.mock("../src/lib/output", () => ({
  log: { ok: f.ok, err: vi.fn(), dim: vi.fn(), info: vi.fn(), warn: vi.fn() },
  table: vi.fn(),
  routeLogsToStderr: vi.fn(),
}));
const { registerDataCommands } = await import("../src/commands/data");
it("awaits the installed Full Update workflow before printing success", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  f.update.mockImplementation(async () => {
    await held;
    return { phase: "complete" };
  });
  f.ok.mockReset();
  const program = new Command();
  registerDataCommands(program);
  const running = program.parseAsync(
    ["data", "update", "europe/germany", "--countries", "DE", "--fail-fast"],
    { from: "user" },
  );
  try {
    await vi.waitFor(() => expect(f.update).toHaveBeenCalled());
    expect(f.ok).not.toHaveBeenCalled();
    expect(f.update).toHaveBeenCalledWith(
      expect.objectContaining({ region: "europe/germany", countries: ["DE"], failFast: true }),
    );
    release();
    await running;
    expect(f.ok).toHaveBeenCalledWith("Update complete");
  } finally {
    release();
    await running;
  }
});
