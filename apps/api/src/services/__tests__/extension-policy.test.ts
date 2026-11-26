import { assert, describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));
vi.mock("../settings", async (original) => ({
  ...(await original<typeof import("../settings")>()),
  resolveSettingValues: vi.fn(),
}));

const { readExtensionPolicy } = await import("../extension-policy");
const { matchesDeclaredType, resolveSettingValues, SETTING_DEFS } = await import("../settings");

describe("extension policy", () => {
  it("reads the four extension settings by their keys", async () => {
    vi.mocked(resolveSettingValues).mockResolvedValue({
      "extensions.catalogSource": "pinned",
      "extensions.revocationCheck": false,
      "extensions.remoteDisable": true,
      "extensions.prereleaseOptIn": ["demo"],
    });
    await expect(readExtensionPolicy({ database: null })).resolves.toEqual({
      catalogSource: "pinned",
      revocationCheck: false,
      remoteDisable: true,
      prereleaseOptIn: ["demo"],
    });
    expect(resolveSettingValues).toHaveBeenCalledWith(
      [
        "extensions.catalogSource",
        "extensions.revocationCheck",
        "extensions.remoteDisable",
        "extensions.prereleaseOptIn",
      ],
      { database: null },
    );
  });

  it("declares the defaults the owner chose and refuses other values", () => {
    const byKey = new Map(SETTING_DEFS.map((def) => [def.key, def]));
    const source = byKey.get("extensions.catalogSource");
    assert(source);
    expect(source).toMatchObject({
      type: "select",
      options: ["latest", "pinned"],
      default: "latest",
    });
    expect(matchesDeclaredType(source, "pinned")).toBe(true);
    expect(matchesDeclaredType(source, "weekly")).toBe(false);
    expect(byKey.get("extensions.revocationCheck")?.default).toBe(true);
    expect(byKey.get("extensions.remoteDisable")?.default).toBe(true);
    const optIn = byKey.get("extensions.prereleaseOptIn");
    assert(optIn);
    expect(optIn.default).toEqual([]);
    expect(matchesDeclaredType(optIn, ["demo", "other-one"])).toBe(true);
    for (const value of [
      ["demo", "demo"],
      ["Demo"],
      [7],
      { demo: true },
      "demo",
      Array.from({ length: 257 }, (_, i) => `e${i}`),
    ])
      expect(matchesDeclaredType(optIn, value), JSON.stringify(value).slice(0, 40)).toBe(false);
  });
});
