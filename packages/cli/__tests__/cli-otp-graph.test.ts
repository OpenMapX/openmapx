import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildOtpGraph,
  type CommandRunner,
  DEFAULT_OTP_BUILD_JAVA_TOOL_OPTIONS,
  OTP_GRAPH_DIR,
  OTP_GRAPH_FILENAME,
} from "../src/lib/otp-graph";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "openmapx-otp-graph-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  mkdirSync(join(tmp, "services", "otp", "config"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "osm"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "gtfs"), { recursive: true });
  writeFileSync(join(tmp, "services", "otp", "config", "build-config.json"), "{}");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("buildOtpGraph", () => {
  it("stages OSM and GTFS inputs, then runs OTP build/save in Docker", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "europe-germany.osm.pbf");
    const gtfs = join(tmp, "infra", "docker", "data", "gtfs", "feed.zip");
    writeFileSync(pbf, "PBF");
    writeFileSync(gtfs, "GTFS");

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const graphDir = join(tmp, "infra", "docker", "data", OTP_GRAPH_DIR);
    const runner: CommandRunner = async (command, args, opts) => {
      calls.push({ command, args, cwd: opts.cwd });
      writeFileSync(join(graphDir, OTP_GRAPH_FILENAME), "GRAPH");
    };

    const result = await buildOtpGraph({
      rootDir: tmp,
      region: "europe/germany",
      image: "opentripplanner/opentripplanner:latest",
      runner,
    });

    expect(readFileSync(join(graphDir, "europe-germany.osm.pbf"), "utf-8")).toBe("PBF");
    expect(readFileSync(join(graphDir, "feed.gtfs.zip"), "utf-8")).toBe("GTFS");
    expect(result.graphPath).toBe(join(graphDir, OTP_GRAPH_FILENAME));
    expect(result.gtfsFeeds).toEqual([join(graphDir, "feed.gtfs.zip")]);
    expect(existsSync(result.graphPath)).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.cwd).toBe(join(tmp, "infra", "docker"));
    expect(calls[0]?.args).toEqual([
      "run",
      "--rm",
      "--name",
      "openmapx-build-otp",
      "-e",
      `JAVA_TOOL_OPTIONS=${DEFAULT_OTP_BUILD_JAVA_TOOL_OPTIONS}`,
      "-v",
      `${graphDir}:/var/opentripplanner`,
      "-v",
      `${join(tmp, "services", "otp", "config", "build-config.json")}:/var/opentripplanner/build-config.json:ro`,
      "opentripplanner/opentripplanner:latest",
      "--build",
      "--save",
    ]);
  });

  it("rejects planet-scale PBFs", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf"), "PBF");

    await expect(
      buildOtpGraph({
        rootDir: tmp,
        region: "planet",
        image: "opentripplanner/opentripplanner:latest",
        runner: async () => {},
      }),
    ).rejects.toThrow(/planet-scale/);
  });
});
