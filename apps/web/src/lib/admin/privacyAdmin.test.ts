import { createApiClient } from "@openmapx/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CASE_A, privacyDetail } from "@/components/admin/privacy/privacyFixtures.test-support";
import { createTestQueryClient } from "@/test/query";
import { privacyAdminQueries, privacyCaseKey } from "./privacyAdmin";

afterEach(() => vi.unstubAllGlobals());
describe("privacy generated client scope", () => {
  it("preserves safe detail through the actual generated operation and transport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify(privacyDetail()), {
            headers: { "content-type": "application/json" },
          }),
      ),
    );
    const client = createApiClient({ baseUrl: "http://privacy.test", credentials: "include" });
    await expect(
      createTestQueryClient().fetchQuery(
        privacyAdminQueries(client, "http://privacy.test", "worker").detail(CASE_A),
      ),
    ).resolves.toEqual(privacyDetail());
    expect(privacyCaseKey("a", "worker", CASE_A)).not.toEqual(
      privacyCaseKey("b", "worker", CASE_A),
    );
    expect(privacyCaseKey("a", "worker", CASE_A)).not.toEqual(privacyCaseKey("a", "other", CASE_A));
  });
});
