import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pruneUnresolvableSources, rewriteRtUrls } from "@openmapx/transitous-core";
import { applyConfigOverrides } from "./config-overrides.js";
import { generateFeedProxyConfig } from "./gen-full-config.js";
import type { StageFn, StageResult } from "./types.js";

const DEFAULT_FEED_PROXY_URL = "http://motis-feed-proxy";

/**
 * Mirror mode: adapt Transitous's published `config.yml` to our deployment.
 *  1. Apply the same env-driven overrides as build mode (osm region, strip
 *     tiles, etc.) so the mirrored config matches our infrastructure.
 *  2. Render OUR feed-proxy nginx config from the catalog's realtime metadata
 *     and repoint the config's realtime URLs (`rt.triptix.tech`) onto it — so
 *     realtime stays independent of Transitous infrastructure. The catalog was
 *     cloned in `prepare`; we pre-skip unresolvable sources first so the
 *     `--feed-proxy` generation can't exit on a credential-gated feed.
 */
export const run: StageFn = async (ctx): Promise<StageResult> => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const catalogDir = ctx.state.catalogDir ?? ctx.catalogDir;
    const configPath = join(ctx.outDir, "config.yml");
    if (!existsSync(configPath)) {
      throw new Error(`mirror-config: ${configPath} missing (did the mirror stage run?)`);
    }

    const overrides = applyConfigOverrides(configPath, ctx.logger);

    // Pre-skip credential-gated sources so the metadata-only --feed-proxy run
    // (inside generateFeedProxyConfig) doesn't exit(1).
    const prunedUnresolvable = await pruneUnresolvableSources({
      catalogDir,
      countries: ctx.countries,
      runner: ctx.runner,
      logger: ctx.logger,
    });

    const feedProxy = await generateFeedProxyConfig(ctx, catalogDir);

    const feedProxyUrl =
      ctx.feedProxyUrl ?? process.env.OPENMAPX_TRANSITOUS_FEED_PROXY_URL ?? DEFAULT_FEED_PROXY_URL;
    const { text, replaced } = rewriteRtUrls(readFileSync(configPath, "utf-8"), feedProxyUrl);
    if (replaced > 0) writeFileSync(configPath, text, "utf-8");

    return {
      stage: "mirror-config",
      status: "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: `Adapted mirrored config (${replaced} realtime URL(s) repointed to our feed-proxy)`,
      artifacts: {
        configPath,
        ...overrides,
        prunedUnresolvable: prunedUnresolvable.length,
        rtRewritten: replaced,
        feedProxyConfigPath: feedProxy.configPath,
        feedProxyEntries: feedProxy.entries,
        feedProxyReloaded: feedProxy.reloaded,
      },
    };
  } catch (error) {
    const err = error as Error;
    return {
      stage: "mirror-config",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message: err.message,
      error: { message: err.message, stack: err.stack },
    };
  }
};
