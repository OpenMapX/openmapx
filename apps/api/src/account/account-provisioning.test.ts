import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openAccountMail, sealAccountMail } from "./account-mail-outbox";

beforeEach(() =>
  vi.stubEnv("BETTER_AUTH_SECRET", "synthetic-strong-auth-secret-for-account-outbox-0001"),
);
afterEach(() => vi.unstubAllEnvs());
it("encrypts mail links and binds them to the exact action and mail kind", () => {
  const mail = {
    to: "synthetic@example.test",
    subject: "Verify email",
    text: "https://example.test/verify?token=synthetic-token",
  };
  const sealed = sealAccountMail("action-a", "email_verification", mail);
  expect(JSON.stringify(sealed)).not.toContain("synthetic-token");
  expect(openAccountMail("action-a", "email_verification", sealed)).toEqual(mail);
  expect(() => openAccountMail("action-b", "email_verification", sealed)).toThrow();
  expect(() => openAccountMail("action-a", "password_setup", sealed)).toThrow();
});
it("records the key version and refuses an unknown one", () => {
  const sealed = sealAccountMail("action-a", "email_verification", {
    to: "synthetic@example.test",
    subject: "Verify",
    text: "synthetic-link",
  });
  expect(sealed.keyVersion).toBe(1);
  expect(() =>
    openAccountMail("action-a", "email_verification", { ...sealed, keyVersion: 2 }),
  ).toThrow(/key version/);
});
it("rejects tampered ciphertext instead of sending a partial message", () => {
  const sealed = sealAccountMail("action-a", "email_verification", {
    to: "synthetic@example.test",
    subject: "Verify",
    text: "synthetic-link",
  });
  expect(() =>
    openAccountMail("action-a", "email_verification", {
      ...sealed,
      tag: Buffer.alloc(16).toString("base64"),
    }),
  ).toThrow();
});

it("rejects protected provisioning fields and unconfirmed assisted verification", async () => {
  const { provisionAccountSchema, assistedAccountVerifySchema } = await import(
    "@openmapx/core/api-contracts"
  );
  const valid = {
    name: "Synthetic",
    email: "synthetic@example.test",
    role: "user",
    sendInvitation: true,
  };
  expect(provisionAccountSchema.safeParse(valid).success).toBe(true);
  expect(provisionAccountSchema.safeParse({ ...valid, emailVerified: true }).success).toBe(false);
  expect(provisionAccountSchema.safeParse({ ...valid, role: ["admin"] }).success).toBe(false);
  expect(
    assistedAccountVerifySchema.safeParse({
      expectedEmail: valid.email,
      reasonCode: "identity_verified_out_of_band",
    }).success,
  ).toBe(false);
});
