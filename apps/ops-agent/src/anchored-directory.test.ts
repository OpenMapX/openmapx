import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openAnchoredDirectory } from "./anchored-directory";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "openmapx-anchored-"));
  roots.push(root);
  const data = join(root, "data");
  const outside = join(root, "outside");
  mkdirSync(join(data, "valhalla", "osm-pbf"), { recursive: true });
  mkdirSync(outside);
  const sentinel = join(outside, "sentinel");
  writeFileSync(sentinel, "untouched");
  return { data, outside, sentinel, shared: join(data, "valhalla", "osm-pbf") };
}

// Descriptor-anchored on Linux; checked by path where /proc/self/fd is missing.
const modes = [
  ...(process.platform === "linux" ? [["descriptor", "/proc/self/fd"] as const] : []),
  ["path", null] as const,
];

describe.each(modes)("anchored directory writes (%s)", (_mode, descriptorAnchorRoot) => {
  it("replaces a planted symlink instead of writing through it", () => {
    const { data, sentinel, shared } = fixture();
    symlinkSync(sentinel, join(shared, "traffic-generations.json"));
    const directory = openAnchoredDirectory(data, ["valhalla", "osm-pbf"], {
      descriptorAnchorRoot,
    });
    try {
      directory.replaceFile("traffic-generations.json", '{"schemaVersion":1}\n', 0o644);
    } finally {
      directory.close();
    }
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(lstatSync(join(shared, "traffic-generations.json")).isFile()).toBe(true);
    expect(readFileSync(join(shared, "traffic-generations.json"), "utf8")).toBe(
      '{"schemaVersion":1}\n',
    );
    // The random temporary is gone, so a guessed name helps nothing.
    expect(readdirSync(shared)).toEqual(["traffic-generations.json"]);
  });

  it("ignores symlinks planted at the old predictable temporary names", () => {
    const { data, sentinel, shared } = fixture();
    symlinkSync(sentinel, join(shared, "traffic-generations.json.f00d.tmp"));
    const directory = openAnchoredDirectory(data, ["valhalla", "osm-pbf"], {
      descriptorAnchorRoot,
    });
    try {
      directory.replaceFile("traffic-generations.json", "{}\n", 0o644);
    } finally {
      directory.close();
    }
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  });

  it("refuses to create over a planted symlink", () => {
    const { data, sentinel, shared } = fixture();
    symlinkSync(sentinel, join(shared, ".traffic-maintenance.json"));
    const directory = openAnchoredDirectory(data, ["valhalla", "osm-pbf"], {
      descriptorAnchorRoot,
    });
    try {
      expect(() => directory.createFile(".traffic-maintenance.json", "{}\n", 0o644)).toThrow();
      directory.removeFile(".traffic-maintenance.json");
    } finally {
      directory.close();
    }
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(existsSync(join(shared, ".traffic-maintenance.json"))).toBe(false);
  });

  it("refuses a directory component replaced by a symlink", () => {
    const { data, outside, sentinel } = fixture();
    rmSync(join(data, "valhalla"), { recursive: true });
    mkdirSync(join(outside, "osm-pbf"));
    symlinkSync(outside, join(data, "valhalla"));
    expect(() =>
      openAnchoredDirectory(data, ["valhalla", "osm-pbf"], { create: true, descriptorAnchorRoot }),
    ).toThrow();
    expect(readdirSync(join(outside, "osm-pbf"))).toEqual([]);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
  });

  it("creates missing components without following anything", () => {
    const { data } = fixture();
    rmSync(join(data, "valhalla"), { recursive: true });
    const directory = openAnchoredDirectory(data, ["valhalla", "osm-pbf"], {
      create: true,
      descriptorAnchorRoot,
    });
    try {
      directory.createFile(".traffic-maintenance.json", "{}\n", 0o644);
    } finally {
      directory.close();
    }
    expect(
      readFileSync(join(data, "valhalla", "osm-pbf", ".traffic-maintenance.json"), "utf8"),
    ).toBe("{}\n");
  });
});

describe.runIf(process.platform === "linux")("anchored directory descriptors", () => {
  it("keeps writing into the directory it opened after its path is swapped", () => {
    const { data, outside, sentinel } = fixture();
    mkdirSync(join(outside, "osm-pbf"));
    const directory = openAnchoredDirectory(data, ["valhalla", "osm-pbf"], {
      descriptorAnchorRoot: "/proc/self/fd",
    });
    try {
      // After the walk, data-manager moves the directory away and leaves a
      // symlink to somewhere else in its place.
      renameSync(join(data, "valhalla"), join(data, "valhalla.moved"));
      symlinkSync(outside, join(data, "valhalla"));
      directory.replaceFile("traffic-generations.json", "{}\n", 0o644);
    } finally {
      directory.close();
    }
    expect(readdirSync(join(outside, "osm-pbf"))).toEqual([]);
    expect(readFileSync(sentinel, "utf8")).toBe("untouched");
    expect(
      readFileSync(join(data, "valhalla.moved", "osm-pbf", "traffic-generations.json"), "utf8"),
    ).toBe("{}\n");
  });
});
