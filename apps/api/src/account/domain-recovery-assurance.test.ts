import { expect, it } from "vitest";
import { isDomainRecoveryAssuranceSufficient } from "./domain-recovery-assurance";

it.each(["passkey", "federated", "password", "password_totp", "password_recovery"] as const)(
  "requires actual origin-independent login provenance for %s",
  (method) => {
    const s = {
      id: "s",
      userId: "u",
      authenticatedAt: new Date(),
      method,
      mfaConfigured: method === "password_totp" || method === "password_recovery",
    };
    expect(isDomainRecoveryAssuranceSufficient(s, false)).toBe(false);
    expect(isDomainRecoveryAssuranceSufficient(s, true)).toBe(
      ["password", "password_totp", "password_recovery"].includes(method),
    );
  },
);
it("requires the configured factor and rejects unknown methods", () => {
  const s = {
    id: "s",
    userId: "u",
    authenticatedAt: new Date(),
    method: "password" as const,
    mfaConfigured: true,
  };
  expect(isDomainRecoveryAssuranceSufficient(s, true)).toBe(false);
  expect(isDomainRecoveryAssuranceSufficient({ ...s, method: "password_totp" }, true)).toBe(true);
  expect(isDomainRecoveryAssuranceSufficient({ ...s, method: "password_recovery" }, true)).toBe(
    true,
  );
});
