import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeedProxyConfig } from "@openmapx/motis-feed-proxy-config";
import { applyConfigOverrides } from "./config-overrides.js";
import { FEED_PROXY_CONTAINER } from "./motis-containers.js";
import type { JobContext, StageFn, StageResult } from "./types.js";

const FEED_PROXY_CONF_REL = "motis-feed-proxy/conf/feed-proxy.conf";

// Mirrors services/motis/tools/transitous/run.sh: merge the `--feed-proxy`
// output (/tmp/feed-proxy-vars.yml) with the catalog's curated feed-whitelist
// and write JSON the nginx renderer consumes. Run with cwd = catalog dir; uses
// ruamel.yaml, which ships in the data-manager image (transitous requirements).
const FEED_PROXY_VARS_TO_JSON_PY = `import json
from pathlib import Path
from ruamel.yaml import YAML

yaml = YAML(typ="safe")
feed_vars: dict = {}
for path in (
    Path("/tmp/feed-proxy-vars.yml"),
    Path("ansible/roles/feed-proxy/vars/feed-whitelist.yml"),
):
    if not path.exists():
        continue
    loaded = yaml.load(path.read_text()) or {}
    if isinstance(loaded, dict):
        feed_vars.update(loaded)
out = Path("out")
out.mkdir(parents=True, exist_ok=True)
(out / "feed-proxy-vars.json").write_text(json.dumps(feed_vars, indent=2, sort_keys=True) + "\\n")
`;

async function generateFeedProxyConfig(
  ctx: JobContext,
  catalogDir: string,
): Promise<{
  configPath: string | null;
  written: boolean;
  reloaded: boolean;
  reloadError?: string;
  entries: number;
}> {
  // Transitous's generator emits two side-effect files: out/config.yml (already
  // produced above) and an additional feed-proxy vars JSON when the
  // `--feed-proxy` flag is set. We run a second invocation so the import
  // config stays clean of GBFS pass-through entries.
  try {
    await ctx.runner(
      "python3",
      ["./src/generate-motis-config.py", "--feed-proxy", "--skip-missing-files", ...ctx.countries],
      { cwd: catalogDir, stdio: "pipe" },
    );
    // `--feed-proxy` writes the RT/GBFS endpoints to `/tmp/feed-proxy-vars.yml`
    // (YAML), NOT `out/`. Mirror the upstream `run.sh` consumer: merge that file
    // with the catalog's feed-whitelist and emit JSON to `out/feed-proxy-vars.json`,
    // which we read below. (The old code read a path the script never writes, so
    // the feed-proxy config was silently never rendered.)
    await ctx.runner("python3", ["-c", FEED_PROXY_VARS_TO_JSON_PY], {
      cwd: catalogDir,
      stdio: "pipe",
    });
  } catch (error) {
    ctx.logger.warn(
      `transitous-pipeline: feed-proxy config generation failed: ${(error as Error).message}`,
    );
    return { configPath: null, written: false, reloaded: false, entries: 0 };
  }

  const jsonPath = join(catalogDir, "out", "feed-proxy-vars.json");
  if (!existsSync(jsonPath)) {
    ctx.logger.warn(
      "transitous-pipeline: feed-proxy vars file not found after --feed-proxy invocation",
    );
    return { configPath: null, written: false, reloaded: false, entries: 0 };
  }
  const varsPath = jsonPath;

  let varsJson: unknown = {};
  try {
    const raw = readFileSync(varsPath, "utf-8").trim();
    if (raw) varsJson = JSON.parse(raw);
  } catch (error) {
    ctx.logger.warn(
      `transitous-pipeline: failed to parse feed-proxy vars at ${varsPath}: ${(error as Error).message}`,
    );
    return { configPath: null, written: false, reloaded: false, entries: 0 };
  }

  const targetPath = join(ctx.dataDir, FEED_PROXY_CONF_REL);
  let entries = 0;
  try {
    const result = await buildFeedProxyConfig({ varsJson, outputPath: targetPath });
    entries = result.entries;
  } catch (error) {
    ctx.logger.warn(
      `transitous-pipeline: feed-proxy nginx render failed: ${(error as Error).message}`,
    );
    return { configPath: null, written: false, reloaded: false, entries: 0 };
  }

  // Signal nginx reload — best effort. If the container isn't running or the
  // data-manager process can't reach the docker socket, we log a warning and
  // leave the freshly-written config on disk for the next container start.
  let reloaded = false;
  let reloadError: string | undefined;
  try {
    await ctx.runner("docker", ["exec", FEED_PROXY_CONTAINER, "nginx", "-s", "reload"], {
      cwd: ctx.dataDir,
      stdio: "pipe",
    });
    reloaded = true;
  } catch (error) {
    reloadError = (error as Error).message;
    ctx.logger.warn(
      `transitous-pipeline: feed-proxy nginx reload failed (${reloadError}); config written but not yet active`,
    );
  }

  return { configPath: targetPath, written: true, reloaded, reloadError, entries };
}

/**
 * Run Transitous's `src/generate-motis-config.py` (without `--import-only`).
 * Produces the runtime config the MOTIS server will load after promotion, and
 * additionally renders the feed-proxy nginx config from `--feed-proxy` output
 * + signals `nginx -s reload` in the `motis-feed-proxy` container (best effort).
 */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const scriptPath = join(catalogDir, "src", "generate-motis-config.py");
    if (!existsSync(scriptPath)) {
      return {
        stage: "gen-full-config",
        status: "skipped",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `generate-motis-config.py not present at ${scriptPath}`,
      } satisfies StageResult;
    }
    // Scope to the build's countries + skip un-fetched feeds (see
    // gen-motis-config.ts) — without region args the upstream script globs every
    // feed file and fails.
    await ctx.runner(
      "python3",
      ["./src/generate-motis-config.py", "--skip-missing-files", ...ctx.countries],
      { cwd: catalogDir, stdio: "pipe" },
    );
    const configPath = join(catalogDir, "out", "config.yml");
    // Apply the SAME post-processors as gen-motis-config so the runtime config
    // the live MOTIS serves agrees with the import-only config staging built
    // against — most importantly the `osm:` extract, whose mismatch (a stale
    // `planet-latest.osm.pbf`) previously failed every post-promote re-import.
    const overrides = applyConfigOverrides(configPath, ctx.logger);

    const feedProxy = await generateFeedProxyConfig(ctx, catalogDir);

    return {
      stage: "gen-full-config",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: "Generated full MOTIS config",
      artifacts: {
        configPath,
        ...overrides,
        feedProxyConfigPath: feedProxy.configPath,
        feedProxyWritten: feedProxy.written,
        feedProxyEntries: feedProxy.entries,
        feedProxyReloaded: feedProxy.reloaded,
        feedProxyReloadError: feedProxy.reloadError,
      },
    };
  } catch (error) {
    const err = error as Error;
    return {
      stage: "gen-full-config",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};
