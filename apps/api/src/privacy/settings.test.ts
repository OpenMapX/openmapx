import { afterEach, describe, expect, it, vi } from "vitest";
import { privacyRetention } from "./settings.js";

afterEach(() => vi.unstubAllEnvs());
describe("privacy retention settings", () => {
  it("honors database settings and environment precedence", async () => {
    vi.stubEnv("LEGAL_DSAR_CASE_RETENTION_DAYS", "");
    const select = vi.fn(() => ({
      from: () => ({ where: () => ({ limit: async () => [{ value: 90 }] }) }),
    }));
    const database = { select } as never;
    expect(await privacyRetention("case", database)).toBe(90);
    vi.stubEnv("LEGAL_DSAR_CASE_RETENTION_DAYS", "120");
    expect(await privacyRetention("case", database)).toBe(120);
    expect(select).toHaveBeenCalledOnce();
    vi.stubEnv("LEGAL_DSAR_CASE_RETENTION_DAYS", "2");
    await expect(privacyRetention("case", database)).rejects.toThrow("retention");
  });

  it("reads the server-log period the privacy page states, from the database when no variable is set", async () => {
    vi.stubEnv("LEGAL_SERVER_LOG_RETENTION_DAYS", "");
    const database = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [{ value: 60 }] }) }) }),
    } as never;
    expect(await privacyRetention("serverLog", database)).toBe(60);
    const empty = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [] }) }) }),
    } as never;
    expect(await privacyRetention("serverLog", empty)).toBe(30);
    vi.stubEnv("LEGAL_SERVER_LOG_RETENTION_DAYS", "0");
    await expect(privacyRetention("serverLog", empty)).rejects.toThrow(
      "LEGAL_SERVER_LOG_RETENTION_DAYS",
    );
  });
});
