import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createAccountAdminClient } from "./accountAdmin";

const calls: { url: string; init: RequestInit }[] = [];
vi.mock("@openmapx/core", async () => ({
  ...(await vi.importActual<typeof import("@openmapx/core")>("@openmapx/core")),
  authClient: { admin: {} },
}));
beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (...args: unknown[]) => {
      const [url, init] = args as [string, RequestInit];
      calls.push({ url: String(url), init });
      return new Response(
        JSON.stringify({
          userId: "subject-a",
          created: false,
          verificationDelivery: "queued",
          passwordSetupDelivery: "queued",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());
it.each(["invitation", "verification-email", "verify", "reset-password", "password"] as const)(
  "uses real generated transport for %s with bounded proof and stable idempotency headers",
  async (action) => {
    const client = createAccountAdminClient("https://api.example.test"),
      key = "test-idempotency-key-0001",
      challengeId = "11111111-1111-4111-8111-111111111111",
      body =
        action === "verify"
          ? {
              confirmed: true,
              expectedEmail: "subject@example.test",
              reasonCode: "identity_verified_out_of_band",
            }
          : action === "password"
            ? { confirmed: true, password: "synthetic-password", reasonCode: "account_recovery" }
            : { confirmed: true };
    await client.recover(action, "subject-a", body, { challengeId }, key);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`https://api.example.test/api/admin/accounts/subject-a/${action}`);
    expect(new Headers(calls[0]?.init.headers).get("idempotency-key")).toBe(key);
    expect(new Headers(calls[0]?.init.headers).get("x-openmapx-reauth-challenge")).toBe(
      challengeId,
    );
    expect(calls[0]?.init.credentials).toBe("include");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual(body);
  },
);
it("uses the actual generated create transport with the selected invitation value", async () => {
  await createAccountAdminClient("https://api.example.test").create(
    {
      name: "Subject",
      email: "subject@example.test",
      password: "synthetic-password",
      role: "user",
      sendInvitation: false,
    },
    "test-idempotency-key-0002",
  );
  expect(calls[0]?.url).toBe("https://api.example.test/api/admin/accounts");
  expect(JSON.parse(String(calls[0]?.init.body))).toMatchObject({ sendInvitation: false });
});
