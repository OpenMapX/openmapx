import { beforeEach, describe, expect, it, vi } from "vitest";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("setLocaleAndReload", () => {
  it("changes the locale cookie before reloading", async () => {
    const reload = vi.fn();
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { reload },
    });
    const { setLocaleAndReload } = await import("./setLocale");

    setLocaleAndReload("de");

    expect(document.cookie).toContain("NEXT_LOCALE=de");
    expect(reload).toHaveBeenCalledTimes(1);
  });
});
