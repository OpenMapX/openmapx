import { describe, expect, it } from "vitest";
import { resolveOperationsProfile } from "../../src/jobs/transitous/operations-profile.js";
import { runMotisPreflight } from "../../src/jobs/transitous/preflight.js";

const regional = resolveOperationsProfile({ countries: ["de"], source: "mirror" });

function preflight(overrides: Partial<Parameters<typeof runMotisPreflight>[0]> = {}) {
  return runMotisPreflight({
    policy: regional,
    feedCount: 10,
    measuredCompressedBytes: 1024 ** 3,
    osmBytes: 2 * 1024 ** 3,
    osmAvailable: true,
    capacity: {
      freeDiskBytes: 500 * 1024 ** 3,
      freeInodes: 1_000_000,
      slotMemoryGb: 16,
      slotCpu: 4,
      fileDescriptorLimit: 65_536,
      buildTimeoutHours: 12,
    },
    ...overrides,
  });
}

describe("MOTIS capacity preflight", () => {
  it("passes a provisioned regional dry run and exposes estimates", () => {
    const result = preflight();
    expect(result.ok).toBe(true);
    expect(result.estimate.requiredDiskBytes).toBeGreaterThan(0);
    expect(result.estimate.basis).toBe("measured-and-conservative");
  });

  it("blocks insufficient disk, inodes, memory, CPU and file descriptors", () => {
    const result = preflight({
      capacity: {
        freeDiskBytes: 1,
        freeInodes: 1,
        slotMemoryGb: 1,
        slotCpu: 1,
        fileDescriptorLimit: 1,
        buildTimeoutHours: 1,
      },
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/disk/);
    expect(result.blockers.join(" ")).toMatch(/inodes/);
    expect(result.blockers.join(" ")).toMatch(/memory/);
    expect(result.blockers.join(" ")).toMatch(/CPU/);
    expect(result.blockers.join(" ")).toMatch(/file-descriptor/);
  });

  it("blocks excessive feed counts and sovereign builds without local OSM", () => {
    expect(preflight({ feedCount: regional.maxFeedCount + 1 }).blockers.join(" ")).toMatch(
      /exceeds profile maximum/,
    );
    const sovereign = resolveOperationsProfile({
      profile: "regional-sovereign",
      countries: ["de"],
      source: "build",
      osmInput: "germany.osm.pbf",
    });
    expect(preflight({ policy: sovereign, osmAvailable: false }).blockers.join(" ")).toMatch(
      /matching local OSM/,
    );
  });

  it("enforces sovereign source isolation and explicit feed allow-lists", () => {
    const sovereign = resolveOperationsProfile({
      profile: "regional-sovereign",
      countries: ["de"],
      source: "build",
      osmInput: "germany.osm.pbf",
    });
    expect(
      preflight({
        policy: sovereign,
        selectedSources: [
          {
            id: "de_bvg",
            originUrl: "https://api.transitous.org/feeds/de.json",
            license: { "spdx-identifier": "CC-BY-4.0" },
          },
        ],
      }).blockers.join(" "),
    ).toMatch(/hosted\/invalid Transitous URLs/);

    expect(
      preflight({
        policy: sovereign,
        selectedSources: [{ id: "de_unknown", originUrl: "https://operator.example/gtfs" }],
      }).blockers.join(" "),
    ).toMatch(/missing license metadata: de_unknown/);

    const allowListed = resolveOperationsProfile({
      countries: [],
      feedAllowList: ["de_bvg"],
      source: "mirror",
    });
    expect(
      preflight({
        policy: allowListed,
        selectedFeedIds: ["de_bvg", "de_vbb"],
      }).blockers.join(" "),
    ).toMatch(/outside allow-list: de_vbb/);
  });

  const sovereign = resolveOperationsProfile({
    profile: "regional-sovereign",
    countries: ["de"],
    source: "build",
    osmInput: "germany.osm.pbf",
  });

  it.each([
    "https://transitous.org/",
    "https://api.transitous.org:8443/feeds/de.json",
    "https://A.B.TRANSITOUS.ORG/gtfs/",
    "https://TRANSITOUS.ORG./gtfs/",
    "http://API.TRANSITOUS.ORG.:8080/gtfs/",
    "not a URL",
    "https://[bad",
    "https://",
  ])("blocks hosted or malformed source URL %s", (originUrl) => {
    const result = preflight({
      policy: sovereign,
      selectedSources: [{ id: "de_bvg", originUrl, license: { "spdx-identifier": "CC-BY-4.0" } }],
    });
    expect(result.ok).toBe(false);
    expect(result.blockers).toContain("sovereign input contains hosted/invalid Transitous URLs");
  });

  it.each([
    "https://nottransitous.org/gtfs/",
    "https://nottransitous.org.:8443/gtfs/",
    "https://mirror-transitous.org/gtfs/",
    "https://transitous.org.example/gtfs/",
    "https://sub.transitous.org.example/gtfs/",
    "https://operator.example/transitous.org?next=https://api.transitous.org/",
    "https://transitous.org@operator.example:8443/gtfs/",
    "http://operator.example:8080/gtfs/",
  ])("allows unrelated source hostname in %s with other requirements met", (originUrl) => {
    const result = preflight({
      policy: sovereign,
      selectedSources: [{ id: "de_bvg", originUrl, license: { "spdx-identifier": "CC-BY-4.0" } }],
    });
    expect(result.ok).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it.each([
    ["https://nottransitous.org/feed.zip", true],
    ["https://transitous.org/feed.zip", false],
    ["https://api.transitous.org./feed.zip", false],
    ["not a URL", false],
  ])("applies the same boundary to sourceUrls fallback %s", (url, ok) => {
    expect(preflight({ policy: sovereign, sourceUrls: [url] }).ok).toBe(ok);
  });

  it("keeps license, origin, allow-list and local OSM blockers for unrelated hosts", () => {
    const result = preflight({
      policy: { ...sovereign, feedAllowList: ["de_bvg"] },
      selectedFeedIds: ["de_unknown"],
      selectedSources: [
        { id: "de_unknown", originUrl: "https://nottransitous.org/feed.zip" },
        { id: "de_missing_origin", license: { "spdx-identifier": "CC-BY-4.0" } },
      ],
      osmAvailable: false,
    });
    expect(result.ok).toBe(false);
    expect(result.blockers.join(" ")).not.toMatch(/hosted\/invalid/);
    expect(result.blockers.join(" ")).toMatch(/outside allow-list: de_unknown/);
    expect(result.blockers.join(" ")).toMatch(/missing license metadata: de_unknown/);
    expect(result.blockers.join(" ")).toMatch(/missing origin URLs: de_missing_origin/);
    expect(result.blockers.join(" ")).toMatch(/matching local OSM/);
  });

  it("labels unknown-size estimates instead of pretending they are measured", () => {
    const result = preflight({ measuredCompressedBytes: undefined });
    expect(result.estimate.basis).toBe("conservative-defaults");
    expect(result.warnings.join(" ")).toMatch(/conservative defaults/);
  });
});
it("treats the actual schedule and artifact identities as aliases of one allowed feed", () => {
  const policy = resolveOperationsProfile({ countries: ["de"], feedAllowList: ["de_demo_test"] });
  const result = runMotisPreflight({
    policy,
    feedCount: 1,
    osmAvailable: false,
    capacity: {
      freeDiskBytes: 10 ** 15,
      slotMemoryGb: 16,
      slotCpu: 4,
      fileDescriptorLimit: 65536,
      buildTimeoutHours: 12,
    },
    selectedFeedIds: ["de_demo_test", "de_demo.test"],
    selectedSources: [{ id: "de_demo_test", artifactId: "de_demo.test" }],
  });
  expect(result.blockers.filter((message) => message.includes("allow-list"))).toEqual([]);
});
