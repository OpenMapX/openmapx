import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyFeedOverlay,
  type FeedFile,
  parseFeedOverlay,
  readFeedOverlay,
  writeFeedOverlayAtomic,
} from "../src/jobs/transitous-feeds-overlay.js";

let tmp: string | undefined;

afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

function validOverlay() {
  return {
    version: 3 as const,
    sources: [
      {
        spec: "gtfs" as const,
        type: "http" as const,
        region: "de",
        name: "operator-feed",
        url: "https://operator.example/feed.zip",
        origin: "operator" as const,
        license: {
          spdxIdentifier: "CC-BY-4.0",
          attribution: "Example transport authority",
        },
      },
    ],
    patches: [{ sourceId: "catalog:de:vbb", skip: true }],
    quarantine: [],
  };
}

describe("version 3 feed overlay", () => {
  it("returns null when the overlay file is missing", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    expect(readFeedOverlay(join(tmp, "missing.json"))).toBeNull();
  });

  it("strictly rejects a version 2 overlay", () => {
    expect(() => parseFeedOverlay({ schemaVersion: 2, additions: [], patches: [] })).toThrow(
      /unsupported version/,
    );
  });

  it.each([
    ["unsafe name", { name: "not_safe" }, /name must match/],
    ["embedded credentials", { url: "https://user:secret@example.test/feed.zip" }, /credentials/],
    ["missing license identity", { license: { attribution: "Authority" } }, /requires/],
  ])("rejects %s", (_label, patch, expected) => {
    const overlay = validOverlay();
    Object.assign(overlay.sources[0], patch);
    expect(() => parseFeedOverlay(overlay)).toThrow(expected);
  });

  it("rejects duplicate normalized identities, names, and URLs", () => {
    const overlay = validOverlay();
    overlay.sources.push({ ...overlay.sources[0] });
    expect(() => parseFeedOverlay(overlay)).toThrow(/duplicate sourceId/);
  });

  it("writes a validated overlay atomically without leaving temporary files", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    writeFeedOverlayAtomic(path, validOverlay());
    expect(readFeedOverlay(path)).toEqual(parseFeedOverlay(validOverlay()));
    expect(readdirSync(tmp)).toEqual(["feeds-overlay.json"]);
    expect(readFileSync(path, "utf-8")).not.toContain("secret");
  });

  it("does not replace the existing file when validation fails", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    writeFileSync(path, "unchanged\n");
    expect(() =>
      writeFeedOverlayAtomic(path, { ...validOverlay(), version: 2 } as never),
    ).toThrow();
    expect(readFileSync(path, "utf-8")).toBe("unchanged\n");
    expect(existsSync(path)).toBe(true);
  });

  it("cleans up its temporary file when the atomic rename fails", () => {
    tmp = mkdtempSync(join(tmpdir(), "openmapx-overlay-"));
    const path = join(tmp, "feeds-overlay.json");
    mkdirSync(path);
    expect(() => writeFeedOverlayAtomic(path, validOverlay())).toThrow();
    expect(readdirSync(tmp)).toEqual(["feeds-overlay.json"]);
  });
});

describe("applyFeedOverlay", () => {
  it("adds an operator source and disables a catalog source by canonical identity", () => {
    const feeds: FeedFile[] = [
      {
        region: "de",
        sources: [{ name: "vbb", spec: "gtfs", type: "http", url: "https://vbb.example/feed.zip" }],
      },
    ];
    const result = applyFeedOverlay(feeds, parseFeedOverlay(validOverlay()));
    expect(result).toMatchObject({ applied: 1, added: 1, quarantined: 0, unmatched: [] });
    expect(feeds[0]?.sources).toEqual([
      expect.objectContaining({
        name: "operator-feed",
        "openmapx-origin": "operator",
        "openmapx-source-id": "operator:de:operator-feed",
        license: {
          "spdx-identifier": "CC-BY-4.0",
          "attribution-text": "Example transport authority",
        },
      }),
      expect.objectContaining({ name: "vbb", skip: true }),
    ]);
  });

  it.each([
    [
      "identity",
      { name: "other", url: "https://other.example/feed.zip" },
      "operator:de:operator-feed",
    ],
    ["name", { name: "operator-feed", url: "https://other.example/feed.zip" }, undefined],
    ["URL", { name: "other", url: "https://operator.example/feed.zip" }, undefined],
  ])("rejects a pinned-catalog %s collision", (_label, catalog, sourceId) => {
    const feeds: FeedFile[] = [
      {
        region: "de",
        sources: [
          {
            ...catalog,
            ...(sourceId ? { "openmapx-source-id": sourceId } : {}),
          },
        ],
      },
    ];
    expect(() => applyFeedOverlay(feeds, parseFeedOverlay(validOverlay()))).toThrow(/collides/);
  });

  it("preserves GBFS quarantine semantics", () => {
    const feeds: FeedFile[] = [{ region: "de", sources: [] }];
    const overlay = parseFeedOverlay({
      version: 3,
      sources: [
        {
          spec: "gbfs",
          type: "url",
          region: "de",
          name: "bikes",
          url: "https://example.test/gbfs.json",
          sourceId: "gbfs:de:bikes",
        },
      ],
      patches: [],
      quarantine: [
        {
          sourceId: "gbfs:de:bikes",
          reason: "invalid",
          firstSeen: "2026-01-01T00:00:00Z",
          lastChecked: "2026-01-02T00:00:00Z",
        },
      ],
    });
    expect(applyFeedOverlay(feeds, overlay)).toMatchObject({ added: 0, quarantined: 1 });
    expect(feeds[0]?.sources).toEqual([]);
  });
});
