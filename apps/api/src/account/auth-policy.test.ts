import { afterEach, expect, it, vi } from "vitest";
import type { AuthDatabase } from "./auth-database";
import { loadAuthPolicy } from "./auth-policy";

afterEach(() => vi.unstubAllEnvs());
it("distinguishes a failed policy read from an unactivated installation", async () => {
  const database = {
    select: () => {
      throw Error("synthetic offline database");
    },
  } as unknown as AuthDatabase;
  await expect(loadAuthPolicy(database)).rejects.toMatchObject({ code: "AUTH_POLICY_UNAVAILABLE" });
});
