import { describe, expect, it } from "vitest";
import { applyCarConfig, CAR_PERMISSIONS } from "./carConfigTransforms";

describe("car host configuration", () => {
  it("is idempotent and preserves unrelated services", () => {
    const source = {
      manifest: { $: {}, application: [{ $: {}, service: [{ $: { "android:name": "other" } }] }] },
    };
    const once = applyCarConfig(source, "https://openmapx.com");
    expect(applyCarConfig(once, "https://openmapx.com")).toEqual(once);
    expect(once.manifest["uses-permission"]?.map((p) => p.$["android:name"])).toEqual(
      CAR_PERMISSIONS,
    );
    expect(once.manifest.application?.[0].service).toEqual(source.manifest.application[0].service);
  });
});
