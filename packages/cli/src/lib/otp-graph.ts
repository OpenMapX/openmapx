import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { execa } from "execa";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

export const OTP_GRAPH_DIR = "otp-graph";
export const OTP_GRAPH_FILENAME = "graph.obj";
export const DEFAULT_OTP_BUILD_JAVA_TOOL_OPTIONS = "-Xmx24g";

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
) => Promise<void>;

export interface BuildOtpGraphOptions {
  rootDir?: string;
  region?: string;
  image: string;
  javaToolOptions?: string;
  runner?: CommandRunner;
}

export interface BuildOtpGraphResult {
  sourcePbf: string;
  graphDir: string;
  graphPath: string;
  gtfsFeeds: string[];
  image: string;
  javaToolOptions: string;
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "inherit" });
}

function linkOrCopy(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

function clearGraphDir(graphDir: string): void {
  rmSync(graphDir, { recursive: true, force: true });
  mkdirSync(graphDir, { recursive: true });
}

function gtfsTargetName(sourceName: string): string {
  if (sourceName.toLowerCase().includes("gtfs")) return sourceName;
  const ext = extname(sourceName);
  const base = sourceName.slice(0, sourceName.length - ext.length);
  return `${base}.gtfs${ext}`;
}

function stageGtfsFeeds(gtfsDir: string, graphDir: string): string[] {
  if (!existsSync(gtfsDir)) return [];
  const feeds = readdirSync(gtfsDir)
    .filter((name) => name.endsWith(".zip"))
    .map((name) => join(gtfsDir, name))
    .filter((path) => statSync(path).isFile());

  const staged: string[] = [];
  for (const feed of feeds) {
    const target = join(graphDir, gtfsTargetName(basename(feed)));
    linkOrCopy(feed, target);
    staged.push(target);
  }
  return staged;
}

function dockerOtpArgs(
  graphDir: string,
  buildConfigPath: string,
  image: string,
  javaToolOptions: string,
): string[] {
  return [
    "run",
    "--rm",
    "--name",
    "openmapx-build-otp",
    "-e",
    `JAVA_TOOL_OPTIONS=${javaToolOptions}`,
    "-v",
    `${graphDir}:/var/opentripplanner`,
    "-v",
    `${buildConfigPath}:/var/opentripplanner/build-config.json:ro`,
    image,
    "--build",
    "--save",
  ];
}

export async function buildOtpGraph(opts: BuildOtpGraphOptions): Promise<BuildOtpGraphResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const sourcePbf = resolveOsmPbf(dataDir, opts.region, "OTP");
  if (basename(sourcePbf) === "planet.osm.pbf" || statSync(sourcePbf).size > 50_000_000_000) {
    throw new Error(
      "OTP cannot build planet-scale graphs (>50GB). Use MOTIS for planet-scale transit.",
    );
  }

  const graphDir = resolve(dataDir, OTP_GRAPH_DIR);
  const image = opts.image;
  const javaToolOptions = opts.javaToolOptions ?? DEFAULT_OTP_BUILD_JAVA_TOOL_OPTIONS;
  const runner = opts.runner ?? defaultRunner;

  clearGraphDir(graphDir);
  linkOrCopy(sourcePbf, join(graphDir, basename(sourcePbf)));
  const gtfsFeeds = stageGtfsFeeds(join(dataDir, "gtfs"), graphDir);

  const buildConfigPath = join(paths.root, "services", "otp", "config", "build-config.json");
  await runner("docker", dockerOtpArgs(graphDir, buildConfigPath, image, javaToolOptions), {
    cwd: paths.infraDir,
    stdio: "inherit",
  });

  const graphPath = join(graphDir, OTP_GRAPH_FILENAME);
  if (!existsSync(graphPath)) {
    throw new Error(`OTP build finished but did not create ${graphPath}`);
  }

  return {
    sourcePbf,
    graphDir,
    graphPath,
    gtfsFeeds,
    image,
    javaToolOptions,
  };
}
