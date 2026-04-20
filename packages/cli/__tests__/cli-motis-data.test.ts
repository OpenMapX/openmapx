import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildMotisData,
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  DEFAULT_TRANSITOUS_TOOLS_IMAGE,
  MOTIS_CONFIG_FILENAME,
  MOTIS_DATA_DIR,
  MOTIS_LICENSE_FILENAME,
} from "../src/lib/motis-data";

let tmp: string;

beforeEach(() => {
  delete process.env.TRANSITOUS_COUNTRIES;
  tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-data-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(tmp, "turbo.json"), "{}\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "osm"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "gtfs"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "services", "transitous"), { recursive: true });
  writeFileSync(join(tmp, "infra", "docker", "services", "transitous", "run.sh"), "#!/bin/sh\n");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildMotisData", () => {
  it("stages MOTIS inputs and generates config, scripts, and attribution artifacts", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf");
    const gtfs = join(tmp, "infra", "docker", "data", "gtfs", "de_bvg.gtfs.zip");
    writeFileSync(pbf, "PBF");
    writeFileSync(gtfs, "GTFS");

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const gtfsDir = join(tmp, "infra", "docker", "data", "gtfs");
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      if (command === "docker" && args.at(-1) === "generate-config") {
        mkdirSync(join(gtfsDir, "scripts"), { recursive: true });
        writeFileSync(
          join(gtfsDir, MOTIS_CONFIG_FILENAME),
          [
            "osm: old-file.osm.pbf",
            "num_days: 365",
            "tiles:",
            "  enabled: true",
            "data_attribution_link: https://transitous.org/sources/",
            "web_folder: /transitous/web",
            "datasets:",
            "  - path: de_bvg.gtfs.zip",
            "",
          ].join("\n"),
        );
        writeFileSync(join(gtfsDir, "scripts", "rt.lua"), "return true\n");
      }
      if (command === "docker" && args.at(-1) === "generate-attribution") {
        writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), '[{"id":"de-bvg"}]\n');
      }
    };

    const result = await buildMotisData({ rootDir: tmp, region: "planet", runner });
    const motisDir = join(tmp, "infra", "docker", "data", MOTIS_DATA_DIR);

    expect(readFileSync(join(motisDir, "planet.osm.pbf"), "utf-8")).toBe("PBF");
    expect(readFileSync(join(motisDir, "de_bvg.gtfs.zip"), "utf-8")).toBe("GTFS");
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).toContain(
      "osm: planet.osm.pbf",
    );
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).toContain("num_days: 90");
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).toContain(
      "data_attribution_link: /terms#data-sources",
    );
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).not.toContain("tiles:");
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).not.toContain(
      "web_folder:",
    );
    expect(readFileSync(join(motisDir, MOTIS_LICENSE_FILENAME), "utf-8")).toContain("de-bvg");
    expect(readFileSync(join(motisDir, "scripts", "rt.lua"), "utf-8")).toBe("return true\n");
    expect(result.sourcePbf).toBe(pbf);
    expect(result.motisDir).toBe(motisDir);
    expect(result.gtfsFeeds).toEqual([join(motisDir, "de_bvg.gtfs.zip")]);
    expect(result.configPath).toBe(join(motisDir, MOTIS_CONFIG_FILENAME));
    expect(result.licensePath).toBe(join(motisDir, MOTIS_LICENSE_FILENAME));
    expect(result.transitousCatalogDir).toBe(
      join(tmp, "infra", "docker", "data", ".transitous-catalog"),
    );
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "clone",
          "--depth",
          "1",
          DEFAULT_TRANSITOUS_REPO_URL,
          join(tmp, "infra", "docker", "data", ".transitous-catalog"),
        ],
        cwd: join(tmp, "infra", "docker", "data"),
      },
      {
        command: "docker",
        args: [
          "build",
          "-t",
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          join(tmp, "infra", "docker", "services", "transitous"),
        ],
        cwd: tmp,
      },
      {
        command: "docker",
        args: expect.arrayContaining([
          "run",
          "--rm",
          "-v",
          `${join(tmp, "infra", "docker", "data", ".transitous-catalog")}:/transitous`,
          "-v",
          `${join(tmp, "infra", "docker", "data", "gtfs")}:/transitous/out`,
          "-v",
          `${join(tmp, "infra", "docker", "data", ".transitous-downloads")}:/transitous/downloads`,
          "-v",
          `${join(tmp, "infra", "docker", "services", "transitous", "run.sh")}:/run.sh:ro`,
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          "/bin/bash",
          "/run.sh",
          "generate-config",
        ]),
        cwd: tmp,
      },
      {
        command: "docker",
        args: expect.arrayContaining([
          "run",
          "--rm",
          "-v",
          `${join(tmp, "infra", "docker", "data", ".transitous-catalog")}:/transitous`,
          "-v",
          `${join(tmp, "infra", "docker", "data", "gtfs")}:/transitous/out`,
          "-v",
          `${join(tmp, "infra", "docker", "data", ".transitous-downloads")}:/transitous/downloads`,
          "-v",
          `${join(tmp, "infra", "docker", "services", "transitous", "run.sh")}:/run.sh:ro`,
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          "/bin/bash",
          "/run.sh",
          "generate-attribution",
        ]),
        cwd: tmp,
      },
    ]);
  });

  it("passes TRANSITOUS_COUNTRIES through to the Transitous tooling container", async () => {
    process.env.TRANSITOUS_COUNTRIES = "de,at";

    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf"), "PBF");
    writeFileSync(join(tmp, "infra", "docker", "data", "gtfs", "de_bvg.gtfs.zip"), "GTFS");

    const dockerRuns: string[][] = [];
    const gtfsDir = join(tmp, "infra", "docker", "data", "gtfs");
    await buildMotisData({
      rootDir: tmp,
      region: "planet",
      runner: async (command, args) => {
        if (command !== "docker") return;
        if (args[0] === "run") dockerRuns.push(args);
        if (args.at(-1) === "generate-config") {
          writeFileSync(join(gtfsDir, MOTIS_CONFIG_FILENAME), "osm: old-file.osm.pbf\n");
        }
        if (args.at(-1) === "generate-attribution") {
          writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), "[]\n");
        }
      },
    });

    expect(dockerRuns).toHaveLength(2);
    for (const args of dockerRuns) {
      expect(args).toEqual(expect.arrayContaining(["-e", "TRANSITOUS_COUNTRIES=de,at"]));
    }
  });

  it("stages OSM input without Transitous tooling when no GTFS feeds are present", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf"), "PBF");

    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await buildMotisData({
      rootDir: tmp,
      region: "planet",
      runner: async (command, args) => {
        calls.push({ command, args });
      },
    });

    expect(result.gtfsFeeds).toEqual([]);
    expect(result.configPath).toBeUndefined();
    expect(result.licensePath).toBeUndefined();
    expect(existsSync(join(tmp, "infra", "docker", "data", MOTIS_DATA_DIR, "planet.osm.pbf"))).toBe(
      true,
    );
    expect(calls).toEqual([]);
  });
});
