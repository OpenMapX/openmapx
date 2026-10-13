import { licensingFromDeclaration } from "@openmapx/mobility-core/licensing";
import { describe, expect, it } from "vitest";
import { withPhotoContributors } from "./photo-contributors";

describe("file-specific contributor capture", () => {
  it("keeps photo and receipt grants immutable when producer metadata changes", () => {
    const licensing = licensingFromDeclaration("CC-BY-SA-4.0", undefined, "Photo", "imagery");
    const captured = withPhotoContributors(
      { source: "photos", url: "https://example.test/image", licensing, author: "Creator" },
      "Photo provider",
    );
    (licensing.bindings[0].license as { expression: string }).expression = "CC0-1.0";
    expect(captured.licensing?.bindings[0].license).toMatchObject({ expression: "CC-BY-SA-4.0" });
    expect(captured.contributors?.[0]).toMatchObject({
      sourceId: "photos",
      publisher: { name: "Creator" },
      licensing: { bindings: [{ scope: "imagery", license: { expression: "CC-BY-SA-4.0" } }] },
    });
  });
  it("keeps authoritative empty receipts", () => {
    expect(
      withPhotoContributors(
        { source: "photos", url: "https://example.test/image", contributors: [] },
        "Provider",
      ).contributors,
    ).toEqual([]);
  });
});

it("copies display licensing even when a photo already has authoritative captured contributors", () => {
  const licensing = licensingFromDeclaration("CC-BY-4.0", undefined, "Photo", "imagery");
  const captured = withPhotoContributors(
    { source: "photos", url: "https://example.test/image", licensing, contributors: [] },
    "Provider",
  );
  (licensing.bindings[0].license as { expression: string }).expression = "CC0-1.0";
  expect(captured.licensing?.bindings[0].license).toMatchObject({ expression: "CC-BY-4.0" });
});
