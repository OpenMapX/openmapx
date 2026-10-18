import { validateArtifactMetadata } from "@openmapx/extension-contracts/artifact";
import { describe, expect, it } from "vitest";

describe("portable artifact envelope validation", () => {
  const metadata = {
    schemaVersion: 1,
    id: "demo",
    platformVersion: "1.0",
    builtAt: "1970-01-01T00:00:00Z",
  };
  it("accepts an earlier compatible protocol minor independently of build identity", () => {
    expect(validateArtifactMetadata(metadata, "demo", "1.2").valid).toBe(true);
  });
  it.each([
    { ...metadata, id: "other" },
    { ...metadata, schemaVersion: 2 },
    { ...metadata, platformVersion: "0.9" },
    { ...metadata, platformVersion: "1.3" },
    { ...metadata, platformVersion: "bogus" },
    { ...metadata, unexpected: true },
  ])("rejects incompatible/mismatched metadata: %j", (value) => {
    expect(validateArtifactMetadata(value, "demo", "1.2").valid).toBe(false);
  });
});
