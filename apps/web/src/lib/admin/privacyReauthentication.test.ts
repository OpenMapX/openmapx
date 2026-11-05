import { beforeEach, describe, expect, it } from "vitest";
import { CASE_A, CASE_B } from "@/components/admin/privacy/privacyFixtures.test-support";
import {
  PRIVACY_ADMIN_RESUME_KEY,
  readPendingPrivacyAdminDelivery,
  savePendingPrivacyAdminDelivery,
} from "./privacyReauthentication";

const now = Date.now();
const value = {
  apiOrigin: "http://privacy.test",
  actorId: "worker",
  requestId: CASE_A,
  artifactId: CASE_B,
  challengeId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  expiresAt: new Date(now + 60000).toISOString(),
  channel: "assisted" as const,
};
beforeEach(() => sessionStorage.clear());
describe("tab-bound privacy delivery resume", () => {
  it("retains exactly the nonsecret allowlist", () => {
    savePendingPrivacyAdminDelivery(value);
    expect(JSON.parse(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)!)).toEqual(value);
    expect(readPendingPrivacyAdminDelivery(value.apiOrigin, value.actorId, now)).toEqual(value);
  });
  it.each(["actor", "origin", "expired", "injected", "invalid-id"])(
    "drops %s records instead of resuming another owner",
    (kind) => {
      sessionStorage.setItem(
        PRIVACY_ADMIN_RESUME_KEY,
        JSON.stringify({
          ...value,
          ...(kind === "expired"
            ? { expiresAt: new Date(now - 1).toISOString() }
            : kind === "injected"
              ? { nonce: "forbidden" }
              : kind === "invalid-id"
                ? { artifactId: "../other" }
                : {}),
        }),
      );
      expect(
        readPendingPrivacyAdminDelivery(
          kind === "origin" ? "http://other.test" : value.apiOrigin,
          kind === "actor" ? "other" : value.actorId,
          now,
        ),
      ).toBeNull();
      expect(sessionStorage.getItem(PRIVACY_ADMIN_RESUME_KEY)).toBeNull();
    },
  );
});
