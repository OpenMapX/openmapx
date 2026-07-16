import { describe, expect, it } from "vitest";
import { integrationManifestSchema } from "../manifest";

function parse(preview: unknown, includePreview = true) {
  const layerSelector: Record<string, unknown> = {
    group: "map-details",
    labelKey: "example",
  };
  if (includePreview) layerSelector.preview = preview;
  return integrationManifestSchema.safeParse({
    id: "overlay-example",
    domains: ["map-overlay"],
    frontend: { layerSelector },
  });
}

describe("frontend.layerSelector.preview", () => {
  it.each([
    ["omitted", undefined, false],
    ["null", null, true],
    ["root-relative", "preview.svg", true],
    ["nested", "assets/layer-preview.svg", true],
    ["case-insensitive extension", "assets/layer-preview.SVG", true],
  ])("accepts %s", (_name, preview, includePreview) => {
    expect(parse(preview, includePreview as boolean).success).toBe(true);
  });

  it.each([
    ["empty", ""],
    ["absolute", "/preview.svg"],
    ["parent traversal", "../preview.svg"],
    ["embedded traversal", "assets/../preview.svg"],
    ["current-directory segment", "assets/./preview.svg"],
    ["empty segment", "assets//preview.svg"],
    ["URL", "https://example/preview.svg"],
    ["backslash", "assets\\preview.svg"],
    ["non-SVG", "preview.png"],
    ["overlong", `${"a".repeat(253)}.svg`],
  ])("rejects %s", (_name, preview) => {
    expect(parse(preview).success).toBe(false);
  });
});
