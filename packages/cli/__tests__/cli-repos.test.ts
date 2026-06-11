import { describe, expect, it } from "vitest";
import { resolveAckDecision } from "../src/commands/repos";

describe("resolveAckDecision", () => {
  it("proceeds when --yes is given (acknowledged on the command line)", () => {
    expect(resolveAckDecision({ yes: true, isTty: false })).toBe("proceed");
    expect(resolveAckDecision({ yes: true, isTty: true })).toBe("proceed");
  });

  it("refuses non-interactively without --yes (never silently acknowledges)", () => {
    expect(resolveAckDecision({ yes: false, isTty: false })).toBe("refuse");
    expect(resolveAckDecision({ isTty: false })).toBe("refuse");
  });

  it("prompts in an interactive TTY without --yes", () => {
    expect(resolveAckDecision({ yes: false, isTty: true })).toBe("prompt");
  });
});
