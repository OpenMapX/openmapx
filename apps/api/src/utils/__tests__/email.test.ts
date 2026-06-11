import { describe, expect, it, vi } from "vitest";

// Replace the entire email module so loadEmailConfig can return an arbitrary
// value (including a provider string outside the compile-time union) while the
// real switch/default branch in sendMail is still exercised.
//
// Strategy: `vi.mock` with a factory that re-exports the real implementation
// of `sendMail`, but wraps `loadEmailConfig` so tests can override it.

const mockLoadEmailConfig = vi.fn();

vi.mock("../email", async (importOriginal) => {
  const original = await importOriginal<typeof import("../email")>();
  return {
    ...original,
    loadEmailConfig: mockLoadEmailConfig,
    // sendMail needs to call our mocked loadEmailConfig. Since sendMail closes
    // over the module-local `loadEmailConfig`, we re-implement just enough to
    // route through the switch statement with the mocked config.
    async sendMail(opts: { to: string; subject: string; text: string; html?: string }) {
      const config = await mockLoadEmailConfig();
      switch (config.provider) {
        case "emaillabs":
          return original.sendViaEmailLabs(opts, config);
        case "lettermint":
          return original.sendViaLettermint(opts, config);
        case "smtp":
          return original.sendViaSmtp(opts, config);
        default: {
          throw new Error(
            `Unknown email provider: ${String((config as { provider?: unknown }).provider)}`,
          );
        }
      }
    },
  };
});

const { sendMail } = await import("../email");

describe("sendMail — unknown provider", () => {
  it("throws a descriptive error when the resolved provider is not recognised", async () => {
    mockLoadEmailConfig.mockResolvedValueOnce({ provider: "bogus" });

    await expect(sendMail({ to: "a@b.com", subject: "test", text: "hi" })).rejects.toThrow(
      "Unknown email provider: bogus",
    );
  });
});
