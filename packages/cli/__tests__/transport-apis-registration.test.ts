import { Command } from "commander";
import { expect, it, vi } from "vitest";

// The ops-agent contains the fixed CLI and packages, not integration implementations.
vi.mock("../../../integrations/transit-dynamic-registry/fetcher", () => {
  throw new Error("Integration implementation is absent from the operator image");
});
vi.mock("../../../integrations/transit-dynamic-registry/validate-endpoint", () => {
  throw new Error("Integration implementation is absent from the operator image");
});

it("registers commands without loading the transit catalog implementation", async () => {
  const { registerTransportApisPinCommands } = await import("../src/commands/transport-apis-pin");
  const program = new Command();
  registerTransportApisPinCommands(program);
  expect(program.commands.some((command) => command.name() === "transit-registry")).toBe(true);
});
