import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildFeedProxyConfig } from "@openmapx/motis-feed-proxy-config";
import { FEED_PROXY_CONTAINER } from "./motis-containers.js";
import type { JobContext, JobLogger, StageFn, StageResult } from "./types.js";

/**
 * Same `incremental_rt_update` post-processor as gen-motis-config.ts.
 * Duplicated rather than imported because both stages independently emit a
 * config.yml and we want the same opt-in to apply to either output without
 * an import cycle. Keep in sync with the upstream copy.
 */
function applyIncrementalRtOverride(configPath: string, logger: JobLogger): boolean {
  const raw = process.env.MOTIS_INCREMENTAL_RT_UPDATE;
  if (raw === undefined) return false;
  const truthy = ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
  const falsy = ["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
  if (!truthy && !falsy) return false;
  if (!existsSync(configPath)) return false;
  let text: string;
  try {
    text = readFileSync(configPath, "utf-8");
  } catch {
    return false;
  }
  const desired = truthy ? "true" : "false";
  const re = /^(\s*incremental_rt_update:\s*)(true|false)\s*$/m;
  const match = text.match(re);
  if (!match || match[2] === desired) return false;
  try {
    writeFileSync(configPath, text.replace(re, `$1${desired}`), "utf-8");
    logger.info(
      `gen-full-config: incremental_rt_update set to ${desired} via MOTIS_INCREMENTAL_RT_UPDATE`,
    );
    return true;
  } catch {
    return false;
  }
}

const FEED_PROXY_CONF_REL = "motis-feed-proxy/conf/feed-proxy.conf";

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
    await ctx.runner("python3", ["./src/generate-motis-config.py", "--feed-proxy"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
  } catch (error) {
    ctx.logger.warn(
      `transitous-pipeline: feed-proxy config generation failed: ${(error as Error).message}`,
    );
    return { configPath: null, written: false, reloaded: false, entries: 0 };
  }

  // Upstream writes the JSON to `out/feed-proxy-vars.json`. Older revisions
  // used `.yml`; we accept either.
  const jsonPath = join(catalogDir, "out", "feed-proxy-vars.json");
  const ymlPath = join(catalogDir, "out", "feed-proxy-vars.yml");
  let varsPath: string | null = null;
  if (existsSync(jsonPath)) varsPath = jsonPath;
  else if (existsSync(ymlPath)) varsPath = ymlPath;
  if (!varsPath) {
    ctx.logger.warn(
      "transitous-pipeline: feed-proxy vars file not found after --feed-proxy invocation",
    );
    return { configPath: null, written: false, reloaded: false, entries: 0 };
  }

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
    await ctx.runner("python3", ["./src/generate-motis-config.py"], {
      cwd: catalogDir,
      stdio: "pipe",
    });
    const configPath = join(catalogDir, "out", "config.yml");
    const incrementalRtOverridden = applyIncrementalRtOverride(configPath, ctx.logger);

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
        incrementalRtOverridden,
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
