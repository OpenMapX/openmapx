import { describe, expect, it } from "vitest";
import { captureMetadata } from "./capture.js";

const revision = "a".repeat(40);
const now = new Date("2026-10-07T00:00:00Z");

describe("search capture provenance", () => {
  it("identifies selected adapted API fields and leaves unobserved revisions unknown", () => {
    expect(captureMetadata("https://openmapx.com/", revision, now)).toEqual({
      protocolVersion: 1,
      layer: "adapted-api",
      representation: "selected-fields",
      recordedAt: "2026-10-07T00:00:00.000Z",
      captureCodeRevision: revision,
      captureWorkingTreeDirty: false,
      apiOrigin: "https://openmapx.com",
      deploymentRevision: null,
      sourceRevisions: null,
      upstreamPayloadCaptured: false,
    });
  });

  it.each([
    "https://user:secret@example.com",
    "https://example.com?key=secret",
    "https://example.com#secret",
    "file:///tmp/secret",
    "not-a-url",
  ])("rejects unsafe capture base %s without including its input in the error", (api) => {
    expect(() => captureMetadata(api, revision, now)).toThrow("Capture API base");
    try {
      captureMetadata(api, revision, now);
    } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain(api);
    }
  });

  it("supports local capture without claiming that revision was deployed", () => {
    const result = captureMetadata("http://localhost:3001/", null, now);
    expect(result.captureCodeRevision).toBeNull();
    expect(
      captureMetadata("http://localhost:3001", revision, now, true).captureWorkingTreeDirty,
    ).toBe(true);
    expect(result.deploymentRevision).toBeNull();
    expect(result.apiOrigin).toBe("http://localhost:3001");
  });
});
