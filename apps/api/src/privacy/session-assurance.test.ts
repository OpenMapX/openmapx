import { describe, expect, it, vi } from "vitest";
import { assuranceMethodForAuthPath, recordSessionFromAuthContext } from "./session-assurance.js";

describe("session authentication assurance", () => {
  it.each([
    ["/sign-in/email", "password"],
    ["/two-factor/verify-totp", "password_totp"],
    ["/two-factor/verify-backup-code", "password_recovery"],
    ["/passkey/verify-authentication", "passkey"],
    ["/callback/openstreetmap", "federated"],
    ["/api/auth/sign-in/email", "password"],
  ])("maps only completed login endpoint %s", (path, expected) => {
    expect(assuranceMethodForAuthPath(path)).toBe(expected);
  });

  it.each(["/sign-out", "/get-session", "/change-password", "/two-factor/enable", undefined])(
    "does not infer assurance for %s",
    (path) => expect(assuranceMethodForAuthPath(path)).toBeUndefined(),
  );

  it("records only a recognized completed session", async () => {
    const onConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
    const insert = vi.fn(() => ({
      values: vi.fn(() => ({ onConflictDoUpdate })),
    }));
    const database = { insert } as never;
    await expect(
      recordSessionFromAuthContext(
        { id: "session-1", userId: "user-1", createdAt: new Date("2026-01-01T00:00:00Z") },
        { path: "/two-factor/verify-totp" },
        database,
      ),
    ).resolves.toBe(true);
    expect(onConflictDoUpdate).toHaveBeenCalled();
    const unknown = await recordSessionFromAuthContext(
      { id: "session-2", userId: "user-1" },
      { path: "/unknown-login" },
      database,
    );
    expect(unknown).toBe(false);
    expect(insert.mock.calls).toHaveLength(1);
  });
  it.each(["passkey", "federated"])("ignores an untrusted %s body marker", async (method) => {
    const insert = vi.fn();
    await expect(
      recordSessionFromAuthContext(
        { id: "new-session", userId: "subject" },
        { path: "/unknown-login", body: { authenticationMethod: method } },
        { insert } as never,
      ),
    ).resolves.toBe(false);
    expect(insert).not.toHaveBeenCalled();
  });
});
