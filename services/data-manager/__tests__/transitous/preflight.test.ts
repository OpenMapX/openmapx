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

  it("labels unknown-size estimates instead of pretending they are measured", () => {
    const result = preflight({ measuredCompressedBytes: undefined });
    expect(result.estimate.basis).toBe("conservative-defaults");
    expect(result.warnings.join(" ")).toMatch(/conservative defaults/);
  });
});
