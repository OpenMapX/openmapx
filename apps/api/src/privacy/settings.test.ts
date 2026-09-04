import { afterEach, describe, expect, it, vi } from "vitest";
import { privacyRetention } from "./settings.js";

afterEach(() => vi.unstubAllEnvs());
describe("privacy retention settings", () => {
  it("honors database settings and environment precedence", async () => {
    vi.stubEnv("LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS", "");
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ value: 48 }] }) }),
    }));
    const database = { select } as never;
    expect(await privacyRetention("artifact", database)).toBe(48);
    vi.stubEnv("LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS", "72");
    expect(await privacyRetention("artifact", database)).toBe(72);
    expect(select).toHaveBeenCalledOnce();
    vi.stubEnv("LEGAL_EXPORT_ARTIFACT_RETENTION_HOURS", "2");
    await expect(privacyRetention("artifact", database)).rejects.toThrow("retention");
  });
});
