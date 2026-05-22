import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFeedOverlay,
  type FeedFile,
  readFeedOverlay,
} from "../src/jobs/transitous-feeds-overlay.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) {
    rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  }
});

describe("readFeedOverlay", () => {
  it("returns null when the overlay file is missing", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "missing.json");
    expect(readFeedOverlay(path)).toBeNull();
  });

  it("parses a valid overlay fixture", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    writeFileSync(
      path,
      JSON.stringify({
        comment: "test fixture",
        patches: [
          {
            region: "de",
            name: "mobidata-bw",
            patch: { url: "https://example.test/feed.zip", "api-key": "secret" },
          },
        ],
      }),
    );
    const overlay = readFeedOverlay(path);
    expect(overlay).not.toBeNull();
    expect(overlay?.patches).toHaveLength(1);
    expect(overlay?.patches[0]).toMatchObject({
      region: "de",
      name: "mobidata-bw",
      patch: { url: "https://example.test/feed.zip", "api-key": "secret" },
    });
  });

  it("treats a missing `patches` array as an empty list", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    writeFileSync(path, JSON.stringify({ comment: "no patches yet" }));
    const overlay = readFeedOverlay(path);
    expect(overlay).toEqual({ patches: [] });
  });

  it("throws when patches is not an array", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    writeFileSync(path, JSON.stringify({ patches: "oops" }));
    expect(() => readFeedOverlay(path)).toThrow(/non-array/);
  });

  it("throws on a patch entry missing required fields", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    writeFileSync(
      path,
      JSON.stringify({
        patches: [{ region: "de", patch: { url: "https://example.test" } }],
      }),
    );
    expect(() => readFeedOverlay(path)).toThrow(/missing string "name"/);
  });
});

describe("applyFeedOverlay", () => {
  it("patches a feed source's URL when name matches", () => {
    const feeds: FeedFile[] = [
      {
        region: "de",
        sources: [
          { name: "mobidata-bw", url: "https://upstream.example/old.zip" },
          { name: "other", url: "https://upstream.example/other.zip" },
        ],
      },
    ];
    const result = applyFeedOverlay(feeds, {
      patches: [
        {
          region: "de",
          name: "mobidata-bw",
          patch: { url: "https://override.example/new.zip", "api-key": "k1" },
        },
      ],
    });
    expect(result.applied).toBe(1);
    expect(result.unmatched).toHaveLength(0);
    expect(feeds[0].sources?.[0]).toMatchObject({
      name: "mobidata-bw",
      url: "https://override.example/new.zip",
      "api-key": "k1",
    });
    // Unrelated sources untouched.
    expect(feeds[0].sources?.[1]).toMatchObject({
      name: "other",
      url: "https://upstream.example/other.zip",
    });
  });

  it("reports patches with no matching region or name as unmatched no-ops", () => {
    const feeds: FeedFile[] = [
      {
        region: "de",
        sources: [{ name: "vbb", url: "https://upstream.example/vbb.zip" }],
      },
    ];
    const result = applyFeedOverlay(feeds, {
      patches: [
        // Region missing entirely.
        { region: "fr", name: "sncf", patch: { url: "https://override.example" } },
        // Region matches, name does not.
        { region: "de", name: "missing-source", patch: { url: "https://override.example" } },
      ],
    });
    expect(result.applied).toBe(0);
    expect(result.unmatched).toHaveLength(2);
    expect(feeds[0].sources?.[0]).toMatchObject({
      name: "vbb",
      url: "https://upstream.example/vbb.zip",
    });
  });

  it("applies the same patch to every source with the matching name", () => {
    const feeds: FeedFile[] = [
      {
        region: "de",
        sources: [
          { name: "duplicate", url: "https://a.example" },
          { name: "duplicate", url: "https://b.example" },
        ],
      },
    ];
    const result = applyFeedOverlay(feeds, {
      patches: [{ region: "de", name: "duplicate", patch: { "api-key": "shared" } }],
    });
    expect(result.applied).toBe(2);
    expect(feeds[0].sources?.[0]).toMatchObject({ "api-key": "shared" });
    expect(feeds[0].sources?.[1]).toMatchObject({ "api-key": "shared" });
  });
});
