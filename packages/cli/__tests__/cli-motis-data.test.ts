import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TRANSITOUS_ARTIFACT_BASE_URL } from "@openmapx/transitous-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runsFromAgentBundle } from "../src/lib/agent-bundle";
import {
  buildMotisData,
  type CommandRunner,
  DEFAULT_TRANSITOUS_REPO_URL,
  DEFAULT_TRANSITOUS_TOOLS_IMAGE,
  importMotisData,
  MOTIS_CONFIG_FILENAME,
  MOTIS_DATA_DIR,
  MOTIS_FEED_PROXY_DIR,
  MOTIS_LICENSE_FILENAME,
  TRANSITOUS_TOOLS_SCRIPT,
} from "../src/lib/motis-data";

vi.mock("../src/lib/agent-bundle", () => ({ runsFromAgentBundle: vi.fn(() => false) }));

let tmp: string;

beforeEach(() => {
  delete process.env.TRANSITOUS_COUNTRIES;
  process.env.OPENMAPX_RELEASE = "local";
  tmp = mkdtempSync(join(tmpdir(), "openmapx-motis-data-"));
  writeFileSync(join(tmp, "pnpm-workspace.yaml"), "packages: []\n");
  writeFileSync(join(tmp, "turbo.json"), "{}\n");
  mkdirSync(join(tmp, "services"), { recursive: true });
  mkdirSync(join(tmp, "services", "motis", "tools", "transitous"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "osm"), { recursive: true });
  mkdirSync(join(tmp, "infra", "docker", "data", "gtfs"), { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
  delete process.env.OPENMAPX_RELEASE;
});

describe("buildMotisData", () => {
  it("stages MOTIS inputs and generates config, scripts, and attribution artifacts", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf");
    const gtfs = join(tmp, "infra", "docker", "data", "gtfs", "de_bvg.gtfs.zip");
    writeFileSync(pbf, "PBF");
    writeFileSync(gtfs, "GTFS");

    const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
    const gtfsDir = join(tmp, "infra", "docker", "data", "gtfs");
    const feedProxyDir = join(tmp, "infra", "docker", "data", MOTIS_FEED_PROXY_DIR);
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
            "gbfs:",
            "  proxy: https://rt.triptix.tech",
            "  feeds:",
            "    de-BVG:",
            "      url: https://rt.triptix.tech/feed/de-BVG-0",
            "datasets:",
            "  - path: de_bvg.gtfs.zip",
            "proxy_url: https://rt.triptix.tech/feed/de-BVG-0",
            "",
          ].join("\n"),
        );
        writeFileSync(join(gtfsDir, "scripts", "rt.lua"), "return true\n");
      }
      if (command === "docker" && args.at(-1) === "generate-attribution") {
        writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), '[{"id":"de-bvg"}]\n');
      }
      if (command === "docker" && args.at(-1) === "generate-feed-proxy-vars") {
        mkdirSync(feedProxyDir, { recursive: true });
        writeFileSync(
          join(feedProxyDir, "feed-proxy-vars.json"),
          JSON.stringify(
            {
              "de-BVG-0": {
                url: "https://rt.triptix.tech/feed/de-BVG-0",
              },
            },
            null,
            2,
          ),
        );
      }
    };

    const result = await buildMotisData({
      rootDir: tmp,
      region: "planet",
      runner,
      source: "build",
    });
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
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).toContain(
      "http://motis-feed-proxy/feed/de-BVG-0",
    );
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).toContain(
      "  proxy: http://motis-feed-proxy",
    );
    expect(readFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "utf-8")).not.toContain(
      "https://rt.triptix.tech",
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
    expect(result.feedProxyConfigPath).toBe(join(feedProxyDir, "conf", "default.conf"));
    expect(result.feedProxyFeedCount).toBe(1);
    expect(readFileSync(join(feedProxyDir, "conf", "default.conf"), "utf-8")).toContain(
      'location "/feed/de-BVG-0"',
    );
    expect(result.transitousCatalogDir).toBe(
      join(tmp, "infra", "docker", "data", ".transitous-catalog"),
    );
    expect(calls).toEqual([
      {
        command: "git",
        args: [
          "-c",
          `safe.directory=${join(tmp, "infra", "docker", "data", ".transitous-catalog")}`,
          "clone",
          "--depth",
          "1",
          "--recurse-submodules",
          "--shallow-submodules",
          "--",
          DEFAULT_TRANSITOUS_REPO_URL,
          join(tmp, "infra", "docker", "data", ".transitous-catalog"),
        ],
        cwd: join(tmp, "infra", "docker", "data"),
      },
      {
        command: "docker",
        args: ["pull", DEFAULT_TRANSITOUS_TOOLS_IMAGE],
        cwd: tmp,
      },
      {
        command: "docker",
        args: [
          "run",
          "--rm",
          "--entrypoint",
          "test",
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          "-x",
          TRANSITOUS_TOOLS_SCRIPT,
        ],
        cwd: tmp,
      },
      {
        // Resolution pre-check: run generate-config in the tools container and
        // act on its "Could not resolve" verdict (delegates to upstream).
        command: "docker",
        args: expect.arrayContaining([
          "run",
          "--rm",
          "-w",
          "/transitous",
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          "python3",
          "./src/generate-motis-config.py",
          "--import-only",
          "--skip-missing-files",
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
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          TRANSITOUS_TOOLS_SCRIPT,
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
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          TRANSITOUS_TOOLS_SCRIPT,
          "generate-attribution",
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
          `${join(tmp, "infra", "docker", "data", MOTIS_FEED_PROXY_DIR)}:/feed-proxy-out`,
          DEFAULT_TRANSITOUS_TOOLS_IMAGE,
          TRANSITOUS_TOOLS_SCRIPT,
          "generate-feed-proxy-vars",
        ]),
        cwd: tmp,
      },
    ]);
  });

  it("only rewrites feed-proxy URLs that have self-hosted proxy mappings", async () => {
    const pbf = join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf");
    const gtfs = join(tmp, "infra", "docker", "data", "gtfs", "de_bvg.gtfs.zip");
    const gtfsDir = join(tmp, "infra", "docker", "data", "gtfs");
    const feedProxyDir = join(tmp, "infra", "docker", "data", MOTIS_FEED_PROXY_DIR);
    writeFileSync(pbf, "PBF");
    writeFileSync(gtfs, "GTFS");

    await buildMotisData({
      rootDir: tmp,
      region: "planet",
      source: "build",
      runner: async (command, args) => {
        if (command !== "docker") return;
        if (args.at(-1) === "generate-config") {
          writeFileSync(
            join(gtfsDir, MOTIS_CONFIG_FILENAME),
            [
              "osm: old-file.osm.pbf",
              "data_attribution_link: https://transitous.org/sources/",
              "datasets:",
              "  de-BVG:",
              "    rt:",
              "      - url: https://rt.triptix.tech/feed/de-BVG-0",
              "      - url: https://rt.triptix.tech/feed/de-VBB-0",
              "",
            ].join("\n"),
          );
        }
        if (args.at(-1) === "generate-attribution") {
          writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), "[]\n");
        }
        if (args.at(-1) === "generate-feed-proxy-vars") {
          mkdirSync(feedProxyDir, { recursive: true });
          writeFileSync(
            join(feedProxyDir, "feed-proxy-vars.json"),
            JSON.stringify(
              {
                "de-BVG-0": {
                  url: "https://example.org/rt.pb",
                },
              },
              null,
              2,
            ),
          );
        }
      },
    });

    const renderedConfig = readFileSync(
      join(tmp, "infra", "docker", "data", MOTIS_DATA_DIR, MOTIS_CONFIG_FILENAME),
      "utf-8",
    );
    expect(renderedConfig).toContain("http://motis-feed-proxy/feed/de-BVG-0");
    expect(renderedConfig).toContain("https://rt.triptix.tech/feed/de-VBB-0");
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
      source: "build",
      runner: async (command, args) => {
        if (command !== "docker") return;
        if (args[0] === "run") dockerRuns.push(args);
        if (args.at(-1) === "generate-config") {
          writeFileSync(join(gtfsDir, MOTIS_CONFIG_FILENAME), "osm: old-file.osm.pbf\n");
        }
        if (args.at(-1) === "generate-attribution") {
          writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), "[]\n");
        }
        if (args.at(-1) === "generate-feed-proxy-vars") {
          mkdirSync(join(tmp, "infra", "docker", "data", MOTIS_FEED_PROXY_DIR), {
            recursive: true,
          });
          writeFileSync(
            join(tmp, "infra", "docker", "data", MOTIS_FEED_PROXY_DIR, "feed-proxy-vars.json"),
            "{}\n",
          );
        }
      },
    });

    // The three tool steps thread TRANSITOUS_COUNTRIES via -e.
    const runShRuns = dockerRuns.filter(
      (args) => args.includes(TRANSITOUS_TOOLS_SCRIPT) && !args.includes("--entrypoint"),
    );
    expect(runShRuns).toHaveLength(3);
    for (const args of runShRuns) {
      expect(args).toEqual(expect.arrayContaining(["-e", "TRANSITOUS_COUNTRIES=de,at"]));
    }
    // The resolution pre-check passes countries as positional region args.
    const pruneRun = dockerRuns.find((args) => args.includes("./src/generate-motis-config.py"));
    expect(pruneRun).toEqual(expect.arrayContaining(["--import-only", "de", "at"]));
  });

  it("stages OSM input without Transitous tooling when no GTFS feeds are present", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf"), "PBF");

    const calls: Array<{ command: string; args: string[] }> = [];
    const result = await buildMotisData({
      rootDir: tmp,
      region: "planet",
      source: "build",
      runner: async (command, args) => {
        calls.push({ command, args });
      },
    });

    expect(result.gtfsFeeds).toEqual([]);
    expect(result.configPath).toBeUndefined();
    expect(result.licensePath).toBeUndefined();
    expect(result.feedProxyConfigPath).toBe(
      join(tmp, "infra", "docker", "data", MOTIS_FEED_PROXY_DIR, "conf", "default.conf"),
    );
    expect(result.feedProxyFeedCount).toBe(0);
    expect(existsSync(join(tmp, "infra", "docker", "data", MOTIS_DATA_DIR, "planet.osm.pbf"))).toBe(
      true,
    );
    expect(calls).toEqual([]);
  });

  it("seeds from the mirror (source=mirror): downloads each cleaned archive by URL, then generates config", async () => {
    writeFileSync(join(tmp, "infra", "docker", "data", "osm", "planet.osm.pbf"), "PBF");
    const dataDir = join(tmp, "infra", "docker", "data");
    const gtfsDir = join(dataDir, "gtfs");
    const catalogDir = join(dataDir, ".transitous-catalog");
    const wgetUrls: string[] = [];
    const dockerActions: string[] = [];

    const result = await buildMotisData({
      rootDir: tmp,
      region: "planet",
      source: "mirror",
      runner: async (command, args) => {
        if (command === "git" && args.includes("clone")) {
          // Simulate the catalog clone: lay down a feed file the mirror reads to
          // learn which archives to download.
          mkdirSync(join(catalogDir, "feeds"), { recursive: true });
          writeFileSync(
            join(catalogDir, "feeds", "de.json"),
            JSON.stringify({ sources: [{ name: "bvg" }] }),
          );
        } else if (command === "wget") {
          // Direct per-archive download to the atomic temp path (-O <tmp>).
          const out = args[args.indexOf("-O") + 1];
          wgetUrls.push(String(args.at(-1)));
          writeFileSync(String(out), "GTFS");
        } else if (command === "docker" && args[0] === "run") {
          dockerActions.push(String(args.at(-1)));
          if (args.at(-1) === "generate-config") {
            writeFileSync(join(gtfsDir, MOTIS_CONFIG_FILENAME), "osm: planet-latest.osm.pbf\n");
          } else if (args.at(-1) === "generate-attribution") {
            writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), '[{"id":"de-bvg"}]\n');
          }
        }
      },
    });

    // Mirror skips fetch.py: it downloads the catalog's feed source archives
    // directly by URL (no recursive autoindex crawl), then still generates the
    // config + attribution from the catalog so the osm/tiles/rt rewrites apply.
    expect(wgetUrls).toContain(`${TRANSITOUS_ARTIFACT_BASE_URL}de_bvg.gtfs.zip`);
    expect(existsSync(join(gtfsDir, "de_bvg.gtfs.zip"))).toBe(true);
    expect(dockerActions).toContain("generate-config");
    expect(dockerActions).toContain("generate-feed-proxy-vars");
    expect(result.configPath).toBe(join(dataDir, MOTIS_DATA_DIR, "config.yml"));
  });
});

describe("importMotisData", () => {
  it("runs `motis import` with the runtime image, mount path, and working dir", async () => {
    const motisDir = join(tmp, "infra", "docker", "data", MOTIS_DATA_DIR);
    mkdirSync(motisDir, { recursive: true });
    writeFileSync(join(motisDir, MOTIS_CONFIG_FILENAME), "osm: x.osm.pbf\n");
    const calls: Array<{ command: string; args: string[] }> = [];

    await importMotisData({
      motisDir,
      image: "ghcr.io/motis-project/motis:2.11.3@sha256:abc",
      runner: async (command, args) => {
        calls.push({ command, args });
      },
    });

    const user =
      typeof process.getuid === "function" && typeof process.getgid === "function"
        ? ["--user", `${process.getuid()}:${process.getgid()}`]
        : [];
    expect(calls).toEqual([
      {
        command: "docker",
        args: [
          "run",
          "--rm",
          "--name",
          "openmapx-build-motis-import",
          ...user,
          "-v",
          `${motisDir}:/motis-data`,
          "-w",
          "/motis-data",
          "--entrypoint",
          "/motis",
          "ghcr.io/motis-project/motis:2.11.3@sha256:abc",
          "import",
        ],
      },
    ]);
  });

  it("refuses when the build staged no config", async () => {
    const motisDir = join(tmp, "infra", "docker", "data", MOTIS_DATA_DIR);
    mkdirSync(motisDir, { recursive: true });
    await expect(importMotisData({ motisDir, image: "m", runner: async () => {} })).rejects.toThrow(
      /needs at least one GTFS feed/,
    );
  });
});

it("never builds a missing exact helper image, even in local mode", async () => {
  process.env.OPENMAPX_RELEASE = "local";
  const pbf = join(tmp, "infra/docker/data/osm/planet.osm.pbf");
  writeFileSync(pbf, "PBF");
  writeFileSync(join(tmp, "infra/docker/data/gtfs/synthetic.gtfs.zip"), "GTFS");
  const calls: string[][] = [];
  const image = `ghcr.io/openmapx/transitous-tools@sha256:${"a".repeat(64)}`;
  const runner: CommandRunner = async (_command, args) => {
    calls.push(args);
    if (args[0] === "pull") throw new Error("synthetic registry unavailable");
  };
  await expect(buildMotisData({ rootDir: tmp, image, runner, source: "build" })).rejects.toThrow(
    /registry unavailable/,
  );
  expect(calls.some((args) => args[0] === "build")).toBe(false);
  delete process.env.OPENMAPX_RELEASE;
});

describe("the transit tools image's own script", () => {
  function writeInputs(): void {
    writeFileSync(join(tmp, "infra/docker/data/osm/planet.osm.pbf"), "PBF");
    writeFileSync(join(tmp, "infra/docker/data/gtfs/synthetic.gtfs.zip"), "GTFS");
  }

  it("runs each step with it and mounts nothing from the checkout's services", async () => {
    writeInputs();
    const gtfsDir = join(tmp, "infra", "docker", "data", "gtfs");
    const calls: string[][] = [];
    await buildMotisData({
      rootDir: tmp,
      region: "planet",
      source: "build",
      runner: async (command, args) => {
        if (command !== "docker") return;
        calls.push(args);
        if (args.at(-1) === "generate-config")
          writeFileSync(join(gtfsDir, MOTIS_CONFIG_FILENAME), "osm: old.osm.pbf\n");
        if (args.at(-1) === "generate-attribution")
          writeFileSync(join(gtfsDir, MOTIS_LICENSE_FILENAME), "[]\n");
        if (args.at(-1) === "generate-feed-proxy-vars") {
          mkdirSync(join(tmp, "infra/docker/data", MOTIS_FEED_PROXY_DIR), { recursive: true });
          writeFileSync(
            join(tmp, "infra/docker/data", MOTIS_FEED_PROXY_DIR, "feed-proxy-vars.json"),
            "{}\n",
          );
        }
      },
    });

    const steps = calls.filter((args) => args.at(-2) === TRANSITOUS_TOOLS_SCRIPT);
    expect(steps.map((args) => args.at(-1))).toEqual([
      "generate-config",
      "generate-attribution",
      "generate-feed-proxy-vars",
    ]);
    expect(calls.flat().filter((arg) => arg.includes(join(tmp, "services")))).toEqual([]);
  });

  it("refuses an image from before it carried the script, naming the remedy", async () => {
    writeInputs();
    const runner: CommandRunner = async (_command, args) => {
      if (args.includes("--entrypoint")) throw new Error("exit 1");
    };
    await expect(
      buildMotisData({ rootDir: tmp, region: "planet", source: "build", runner }),
    ).rejects.toThrow(
      `The transit tools image ${DEFAULT_TRANSITOUS_TOOLS_IMAGE} has no ${TRANSITOUS_TOOLS_SCRIPT}: it is from an earlier release than this CLI. Select the checkout's release with pnpm openmapx compose release`,
    );
  });

  it("is never built from the checkout by the operations agent", async () => {
    writeInputs();
    vi.mocked(runsFromAgentBundle).mockReturnValueOnce(true);
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
    };
    await expect(
      buildMotisData({
        rootDir: tmp,
        region: "planet",
        source: "build",
        image: "openmapx/transitous-tools:local",
        runner,
      }),
    ).rejects.toThrow(/operations agent does not build the transit tools image/);
    expect(calls.some((args) => args[0] === "build")).toBe(false);
  });
});
