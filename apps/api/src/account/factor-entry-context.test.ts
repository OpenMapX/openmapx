import { expect, it, vi } from "vitest";
import { currentFactorEntryHadSession, withFactorEntrySession } from "./factor-entry-context";

it("records only an actual absent-session factor entry", async () => {
  expect(currentFactorEntryHadSession()).toBeUndefined();
  await withFactorEntrySession(
    "verifyTOTP",
    async () => null,
    async () => expect(currentFactorEntryHadSession()).toBe(false),
  );
  await withFactorEntrySession(
    "/api/auth/two-factor/verify-backup-code",
    async () => ({ session: { id: "existing" } }),
    async () => expect(currentFactorEntryHadSession()).toBe(true),
  );
  expect(currentFactorEntryHadSession()).toBeUndefined();
});
it("fails closed on direct session-read error or invalid response", async () => {
  const run = vi.fn();
  await expect(
    withFactorEntrySession(
      "verifyTOTP",
      async () => {
        throw Error("synthetic DB error");
      },
      run,
    ),
  ).rejects.toThrow();
  await expect(
    withFactorEntrySession("verifyBackupCode", async () => undefined, run),
  ).rejects.toThrow();
  expect(run).not.toHaveBeenCalled();
});
