import { createHash } from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  linkSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, join, resolve } from "node:path";
import { execa } from "execa";
import { resolveOsmPbf } from "./osm-pbf";
import { repoPaths } from "./paths";

export const OSRM_GRAPH_DIR = "osrm-graph";
export const OSRM_INPUT_FILENAME = "region.osm.pbf";
export const OSRM_GRAPH_BASENAME = "region.osrm";
export const DEFAULT_OSRM_PROFILE = "/opt/car.lua";
const PBF_HASH_FILE = ".osrm-pbf-hash";

export type CommandRunner = (
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
) => Promise<void>;

export interface BuildOsrmGraphOptions {
  rootDir?: string;
  region?: string;
  image: string;
  profile?: string;
  runner?: CommandRunner;
}

export interface BuildOsrmGraphResult {
  sourcePbf: string;
  graphDir: string;
  graphPath: string;
  image: string;
  profile: string;
}

export function resolveOsmPbfForOsrm(dataDir: string, region?: string): string {
  return resolveOsmPbf(dataDir, region, "OSRM");
}

function clearPreviousOsrmGraph(graphDir: string): void {
  mkdirSync(graphDir, { recursive: true });
  for (const name of readdirSync(graphDir)) {
    if (name === OSRM_INPUT_FILENAME || name.startsWith(`${OSRM_GRAPH_BASENAME}`)) {
      rmSync(join(graphDir, name), { recursive: true, force: true });
    }
  }
}

function linkOrCopy(source: string, target: string): void {
  try {
    linkSync(source, target);
  } catch {
    copyFileSync(source, target);
  }
}

async function defaultRunner(
  command: string,
  args: string[],
  opts: { cwd?: string; stdio?: "inherit" },
): Promise<void> {
  await execa(command, args, { cwd: opts.cwd, stdio: opts.stdio ?? "inherit" });
}

function dockerOsrmArgs(graphDir: string, image: string, command: string[]): string[] {
  return ["run", "--rm", "-v", `${graphDir}:/data`, image, ...command];
}

/**
 * Hash the input PBF (size + sha256) so we can skip the OSRM extract/partition/
 * customize cycle when the source data hasn't changed. OSRM's three-stage build
 * is the slowest part of the routing stack — saving it on a no-op rebuild is
 * worth the few seconds of hashing.
 */
async function hashPbf(pbfPath: string): Promise<string> {
  const stat = statSync(pbfPath);
  return new Promise((resolveHash, rejectHash) => {
    const hash = createHash("sha256");
    const stream = createReadStream(pbfPath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolveHash(`${stat.size}:${hash.digest("hex")}`));
    stream.on("error", rejectHash);
  });
}

export async function buildOsrmGraph(opts: BuildOsrmGraphOptions): Promise<BuildOsrmGraphResult> {
  const paths = repoPaths(opts.rootDir);
  const dataDir = join(paths.infraDir, "data");
  const graphDir = resolve(dataDir, OSRM_GRAPH_DIR);
  const sourcePbf = resolveOsmPbfForOsrm(dataDir, opts.region);
  if (basename(sourcePbf) === "planet.osm.pbf" || statSync(sourcePbf).size > 50_000_000_000) {
    throw new Error(
      "OSRM cannot build planet-scale graphs (>50GB). Use Valhalla for planet-scale routing.",
    );
  }
  const profile = opts.profile ?? DEFAULT_OSRM_PROFILE;
  const runner = opts.runner ?? defaultRunner;

  // Skip the build entirely if the input PBF hash matches the one captured
  // by the previous build AND the graph artefact still exists. The hash file
  // also encodes the OSRM profile, so changing routing profiles forces a
  // rebuild even on identical PBFs.
  const newHash = `${profile}|${await hashPbf(sourcePbf)}`;
  const hashPath = join(graphDir, PBF_HASH_FILE);
  const graphPath = join(graphDir, OSRM_GRAPH_BASENAME);
  if (existsSync(hashPath) && existsSync(graphPath)) {
    try {
      const previous = readFileSync(hashPath, "utf-8").trim();
      if (previous === newHash) {
        return {
          sourcePbf,
          graphDir,
          graphPath,
          image: opts.image,
          profile,
        };
      }
    } catch {
      // Hash file unreadable — fall through and rebuild.
    }
  }

  clearPreviousOsrmGraph(graphDir);
  linkOrCopy(sourcePbf, join(graphDir, OSRM_INPUT_FILENAME));

  const cwd = paths.infraDir;
  await runner(
    "docker",
    dockerOsrmArgs(graphDir, opts.image, [
      "osrm-extract",
      "-p",
      profile,
      `/data/${OSRM_INPUT_FILENAME}`,
    ]),
    { cwd, stdio: "inherit" },
  );
  await runner(
    "docker",
    dockerOsrmArgs(graphDir, opts.image, ["osrm-partition", `/data/${OSRM_GRAPH_BASENAME}`]),
    { cwd, stdio: "inherit" },
  );
  await runner(
    "docker",
    dockerOsrmArgs(graphDir, opts.image, ["osrm-customize", `/data/${OSRM_GRAPH_BASENAME}`]),
    { cwd, stdio: "inherit" },
  );

  if (!existsSync(graphPath)) {
    throw new Error(`OSRM build finished but did not create ${graphPath}`);
  }
  writeFileSync(hashPath, `${newHash}\n`, "utf-8");

  return {
    sourcePbf,
    graphDir,
    graphPath,
    image: opts.image,
    profile,
  };
}
