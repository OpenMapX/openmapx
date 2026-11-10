import { expect, it } from "vitest";
import { unactivatedAuthPolicy } from "./auth-policy";
import {
  applyPasswordVerificationPolicy,
  isReservedInvalidAddress,
} from "./password-verification-policy";

it.each([
  ["4242@osm.invalid", true],
  ["4242@mapillary.invalid", true],
  ["Person@OSM.INVALID", true],
  ["person@osm.invalid.", true],
  ["person@invalid", true],
  ['"odd@local"@osm.invalid', true],
  ["person@example.test", false],
  ["person@invalid.example.test", false],
  ["person@notinvalid", false],
  ["invalid@example.test", false],
])("classifies %s as a reserved address: %s", (address, reserved) => {
  expect(isReservedInvalidAddress(address)).toBe(reserved);
});

it("refuses changed reset verification patches instead of merging emailVerified back", async () => {
  const hook = applyPasswordVerificationPolicy(unactivatedAuthPolicy).userHooks.update?.before;
  if (!hook) throw Error("Missing database guard");
  const context = { path: "/email-otp/reset-password" } as Parameters<typeof hook>[1];
  await expect(hook({ emailVerified: true }, context)).resolves.toBe(false);
  await expect(hook({ emailVerified: true, name: "Unexpected" }, context)).rejects.toThrow(
    "Unexpected password reset verification change",
  );
});
