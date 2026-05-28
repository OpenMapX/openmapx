import { afterEach, describe, expect, it, vi } from "vitest";

const ORIGINAL = process.env.ISOCHRONE_PROVIDER;

async function loadProvider(value: string | undefined) {
  if (value === undefined) delete process.env.ISOCHRONE_PROVIDER;
  else process.env.ISOCHRONE_PROVIDER = value;
  vi.resetModules();
  const { getIsochroneProvider } = await import("../factory.js");
  return getIsochroneProvider();
}

describe("getIsochroneProvider", () => {
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.ISOCHRONE_PROVIDER;
    else process.env.ISOCHRONE_PROVIDER = ORIGINAL;
    vi.resetModules();
  });

  it.each([
    ["unset", undefined],
    ["empty string", ""],
    ["whitespace only", "   "],
    ["explicit valhalla", "valhalla"],
    ["mixed case", "VALHALLA"],
  ])("resolves the valhalla provider when %s", async (_label, value) => {
    const provider = await loadProvider(value);
    expect(provider.isochrone).toBeTypeOf("function");
  });

  it("throws on an unknown provider", async () => {
    await expect(loadProvider("mapbox")).rejects.toThrow(/Unknown ISOCHRONE_PROVIDER/);
  });
});
