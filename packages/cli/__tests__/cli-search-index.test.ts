import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildSearchIndexMock, searchIndexStatusMock } = vi.hoisted(() => ({
  buildSearchIndexMock: vi.fn(),
  searchIndexStatusMock: vi.fn(),
}));

vi.mock("@openmapx/core/server", () => ({
  services: {
    DataManagerClient: class {
      buildSearchIndex = buildSearchIndexMock;
      searchIndexStatus = searchIndexStatusMock;
    },
  },
}));

const { registerDataCommands } = await import("../src/commands/data");

function makeProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerDataCommands(program);
  return program;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("data search-index CLI", () => {
  it("exposes nested build and status commands", () => {
    const program = makeProgram();
    const data = program.commands.find((command) => command.name() === "data");
    const searchIndex = data?.commands.find((command) => command.name() === "search-index");

    expect(searchIndex?.commands.map((command) => command.name())).toEqual(["build", "status"]);
  });

  it("builds the selected region and forwards progress messages", async () => {
    buildSearchIndexMock.mockImplementationOnce(
      async (_region: string, onProgress: (message: string) => void) => {
        onProgress("Extracted 42 places");
        return { ok: true, epoch: "epoch-2", placeCount: 42, termCount: 84 };
      },
    );
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await makeProgram().parseAsync(["data", "search-index", "build", "europe/germany"], {
      from: "user",
    });

    expect(buildSearchIndexMock).toHaveBeenCalledWith("europe/germany", expect.any(Function));
    expect(output.mock.calls.flat().join(" ")).toContain("Extracted 42 places");
    expect(output.mock.calls.flat().join(" ")).toContain("42 places");
  });

  it("prints the operational status fields", async () => {
    searchIndexStatusMock.mockResolvedValueOnce({
      region: "europe/germany",
      status: "ready",
      stale: true,
      building: false,
      epoch: "epoch-1",
      placeCount: 123,
      termCount: 456,
      sourceFingerprint: "sha256:abc",
      startedAt: "2026-08-13T01:00:00.000Z",
      publishedAt: "2026-08-13T01:05:00.000Z",
      lastError: null,
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await makeProgram().parseAsync(["data", "search-index", "status"], { from: "user" });

    const text = output.mock.calls.flat().join(" ");
    expect(text).toContain("europe/germany");
    expect(text).toContain("epoch-1");
    expect(text).toContain("123");
    expect(text).toContain("456");
    expect(text).toContain("sha256:abc");
    expect(text).toContain("2026-08-13T01:05:00.000Z");
  });
});
