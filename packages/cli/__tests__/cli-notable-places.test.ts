import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { buildNotablePlacesMock, notablePlacesStatusMock } = vi.hoisted(() => ({
  buildNotablePlacesMock: vi.fn(),
  notablePlacesStatusMock: vi.fn(),
}));

vi.mock("@openmapx/core/server", () => ({
  services: {
    DataManagerClient: class {
      buildNotablePlaces = buildNotablePlacesMock;
      notablePlacesStatus = notablePlacesStatusMock;
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

describe("data notable-places CLI", () => {
  it("builds the index and forwards progress messages", async () => {
    buildNotablePlacesMock.mockImplementationOnce(async (onProgress: (message: string) => void) => {
      onProgress("Fetching labels in en");
      return { ok: true, epoch: "e1", placeCount: 150_000, nameCount: 790_000 };
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await makeProgram().parseAsync(["data", "notable-places", "build"], { from: "user" });

    expect(buildNotablePlacesMock).toHaveBeenCalledWith(expect.any(Function));
    const printed = output.mock.calls.flat().join(" ");
    expect(printed).toContain("Fetching labels in en");
    expect(printed).toContain("150000 places");
  });

  it("prints the published snapshot", async () => {
    notablePlacesStatusMock.mockResolvedValueOnce({
      status: "ready",
      building: false,
      placeCount: 150_000,
      nameCount: 790_000,
      minSitelinks: 8,
      source: "https://qlever.dev/api/wikidata",
      epoch: "e1",
      publishedAt: "2026-10-01T00:00:00.000Z",
      lastError: null,
    });
    const output = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await makeProgram().parseAsync(["data", "notable-places", "status"], { from: "user" });

    const printed = output.mock.calls.flat().join(" ");
    expect(printed).toContain("ready");
    expect(printed).toContain("https://qlever.dev/api/wikidata");
  });
});
