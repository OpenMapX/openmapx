import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildFeedProxyConfig,
  FEED_PROXY_CONFIG_FILENAME,
  FEED_PROXY_CONFIG_SUBDIR,
  FEED_PROXY_VARS_FILENAME,
  writeFeedProxyVarsFile,
} from "@openmapx/motis-feed-proxy-config";
import { findHostedGbfsFeedIds, rewriteHostedFeedProxy } from "@openmapx/transitous-core";
import { CANDIDATE_PROXY_DIRNAME } from "./candidate.js";
import { applyConfigOverrides } from "./config-overrides.js";
import type { JobContext, StageFn, StageResult } from "./types.js";

const DEFAULT_FEED_PROXY_URL = "http://motis-feed-proxy";
const HOSTED_TRANSIT_RUNTIME_DOMAINS = ["transitous.org", "triptix.tech"] as const;

function assertSovereignRuntimeConfig(config: string): void {
  const prohibited = [...config.matchAll(/https?:\/\/[^\s"'<>]+/g)]
    .map((match) => match[0].replace(/[),\]}]+$/, ""))
    .filter((url) => {
      try {
        const hostname = new URL(url).hostname.toLowerCase();
        return HOSTED_TRANSIT_RUNTIME_DOMAINS.some(
          (domain) => hostname === domain || hostname.endsWith(`.${domain}`),
        );
      } catch {
        return true;
      }
    });
  if (prohibited.length > 0) {
    throw new Error(
      `regional-sovereign config contains prohibited hosted runtime URLs: ${[...new Set(prohibited)].join(", ")}`,
    );
  }
}

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

export async function generateFeedProxyConfig(
  ctx: JobContext,
  catalogDir: string,
): Promise<{
  configPath: string | null;
  written: boolean;
  reloaded: boolean;
  reloadError?: string;
  entries: number;
  /** Feed ids our proxy serves (vars keys) — used to scope the RT rewrite. */
  feedIds: string[];
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
    return { configPath: null, written: false, reloaded: false, entries: 0, feedIds: [] };
  }

  const jsonPath = join(catalogDir, "out", "feed-proxy-vars.json");
  if (!existsSync(jsonPath)) {
    ctx.logger.warn(
      "transitous-pipeline: feed-proxy vars file not found after --feed-proxy invocation",
    );
    return { configPath: null, written: false, reloaded: false, entries: 0, feedIds: [] };
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
    return { configPath: null, written: false, reloaded: false, entries: 0, feedIds: [] };
  }

  const feedIds =
    varsJson && typeof varsJson === "object"
      ? Object.keys(varsJson as Record<string, unknown>)
      : [];
  const proxyRoot = join(catalogDir, "out", CANDIDATE_PROXY_DIRNAME);
  const targetPath = join(proxyRoot, FEED_PROXY_CONFIG_SUBDIR, FEED_PROXY_CONFIG_FILENAME);
  const persistedVarsPath = join(proxyRoot, FEED_PROXY_VARS_FILENAME);
  let entries = 0;
  try {
    const normalizedVars = writeFeedProxyVarsFile(persistedVarsPath, varsJson);
    const result = await buildFeedProxyConfig({ varsJson: normalizedVars, outputPath: targetPath });
    entries = result.entries;
  } catch (error) {
    ctx.logger.warn(
      `transitous-pipeline: feed-proxy nginx render failed: ${(error as Error).message}`,
    );
    return { configPath: null, written: false, reloaded: false, entries: 0, feedIds: [] };
  }

  // This is an immutable candidate artifact. Plan 002's proxy transaction
  // validates and activates a union with the current live routes only after
  // assembly; config generation must never mutate live nginx state.
  return { configPath: targetPath, written: true, reloaded: false, entries, feedIds };
}

/**
 * Run Transitous's `src/generate-motis-config.py` (without `--import-only`).
 * Produces the runtime config the MOTIS server will load after promotion, and
 * additionally renders an immutable feed-proxy candidate from `--feed-proxy`
 * output. Activation is owned by the later transactional proxy stage.
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
    if (!existsSync(configPath)) {
      throw new Error(`generate-motis-config.py did not produce ${configPath}`);
    }
    // Apply the SAME post-processors as gen-motis-config so the runtime config
    // the live MOTIS serves agrees with the import-only config staging built
    // against — most importantly the `osm:` extract, whose mismatch (a stale
    // `planet-latest.osm.pbf`) previously failed every post-promote re-import.
    const overrides = applyConfigOverrides(configPath, ctx.logger);

    const feedProxy = await generateFeedProxyConfig(ctx, catalogDir);
    if (!feedProxy.written || !feedProxy.configPath) {
      throw new Error(
        "Feed proxy candidate could not be rendered; refusing an unproxied MOTIS config",
      );
    }

    // Repoint the runtime config's realtime URLs (Transitous's hosted
    // rt.triptix.tech) onto OUR feed-proxy so realtime is independent of
    // Transitous infrastructure. Scoped to the feeds our proxy actually serves
    // (so we never break RT for a feed the proxy has no config for). Applies in
    // both build and mirror mode.
    // `||` (not `??`): compose injects `${VAR:-}` as an empty string when the
    // operator hasn't set it, and "" must fall through to the default.
    const feedProxyUrl =
      ctx.feedProxyUrl || process.env.OPENMAPX_TRANSITOUS_FEED_PROXY_URL || DEFAULT_FEED_PROXY_URL;
    let rtRewritten = 0;
    let gbfsProxyRewritten = 0;
    if (existsSync(configPath)) {
      const result = rewriteHostedFeedProxy(
        readFileSync(configPath, "utf-8"),
        feedProxyUrl,
        new Set(feedProxy.feedIds),
      );
      rtRewritten = result.counts.realtimeUrls;
      gbfsProxyRewritten = result.counts.gbfsProxy;
      const missingGbfsFeedIds = findHostedGbfsFeedIds(result.text);
      if (missingGbfsFeedIds.length > 0) {
        throw new Error(
          `Local feed proxy is missing configured GBFS feeds: ${missingGbfsFeedIds.join(", ")}`,
        );
      }
      if (rtRewritten > 0 || gbfsProxyRewritten > 0) {
        writeFileSync(configPath, result.text, "utf-8");
      }
      if (ctx.operationsPolicy.profile === "regional-sovereign") {
        assertSovereignRuntimeConfig(result.text);
      }
    }

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
        rtRewritten,
        gbfsProxyRewritten,
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
