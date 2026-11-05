import { expect, it } from "vitest";
import { unactivatedAuthPolicy } from "./auth-policy";
import { applyPasswordVerificationPolicy } from "./password-verification-policy";

it("refuses changed reset verification patches instead of merging emailVerified back", async () => {
  const hook = applyPasswordVerificationPolicy(unactivatedAuthPolicy).userHooks.update?.before;
  if (!hook) throw Error("Missing database guard");
  const context = { path: "/email-otp/reset-password" } as Parameters<typeof hook>[1];
  await expect(hook({ emailVerified: true }, context)).resolves.toBe(false);
  await expect(hook({ emailVerified: true, name: "Unexpected" }, context)).rejects.toThrow(
    "Unexpected password reset verification change",
  );
});
