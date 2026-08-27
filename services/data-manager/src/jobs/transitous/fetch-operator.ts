import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubSecrets, scrubSecretsOptional } from "../../utils/scrub-secrets.js";
import { feedKeyForSource, recordFetchOutcome } from "./feed-state-writer.js";
import { operatorFeedScript, runFetchPipeline } from "./internal.js";
import { finalizeTransitSourceManifest } from "./source-manifest.js";
import type { FeedDownloadFailure, FeedFileEntry, StageFn } from "./types.js";

const RELAY_CAPABILITY_PATTERN = /\/internal\/transit\/operator-feed\/[a-f0-9]{64}/gi;

function redactRelayCapability(value: string): string {
  return scrubSecrets(value).replace(
    RELAY_CAPABILITY_PATTERN,
    "/internal/transit/operator-feed/[redacted]",
  );
}

function safeFailureHostname(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "[invalid-host]";
  }
}

function redactFailures(failures: FeedDownloadFailure[]): FeedDownloadFailure[] {
  return failures.map((failure) => ({
    ...failure,
    url: safeFailureHostname(failure.url),
    message: redactRelayCapability(failure.message),
  }));
}

function materializeOperatorMetadata(ctx: Parameters<StageFn>[0]): FeedFileEntry[] {
  // One fixed directory reused per run — a per-job directory would accumulate
  // forever in the download cache.
  const directory = join(ctx.downloadsDir, "operator-metadata");
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  ctx.state.operatorMetadataDir = directory;
  return (ctx.state.selectedFeedFiles ?? []).flatMap((feed) => {
    const sources = feed.activeScheduleSources.filter((source) => source.origin === "operator");
    if (sources.length === 0) return [];
    const path = join(directory, `${feed.id}.json`);
    writeFileSync(
      path,
      `${JSON.stringify(
        {
          maintainers: [{ name: "OpenMapX operator", github: "openmapx" }],
          sources: sources.map((source) => ({
            name: source.name,
            spec: source.format,
            type: "http",
            url: source.originUrl,
            license: source.license,
          })),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );
    return [{ ...feed, path, activeScheduleSources: sources }];
  });
}

async function persistOutcomes(
  feeds: FeedFileEntry[],
  failures: FeedDownloadFailure[],
  ctx: Parameters<StageFn>[0],
): Promise<void> {
  // Match failures on the synthesized source id — the (region, name) natural
  // key diverges from it for subdivision regions and sanitized names, which
  // would record a failed source as fetched.
  const failed = new Set(failures.map((failure) => failure.id.toLowerCase()));
  for (const feed of feeds) {
    for (const source of feed.activeScheduleSources) {
      const key = feedKeyForSource(feed, source.name, source.region);
      try {
        await recordFetchOutcome({
          ...key,
          ok: !failed.has(source.id.toLowerCase()),
        });
      } catch (error) {
        ctx.logger.warn(
          `transitous-fetch-operator: feed_state write failed for ${key.region}/${key.name}: ${(error as Error).message}`,
        );
      }
    }
  }
}

/** Mirror-mode acquisition for operator URLs through the pinned Transitous fetcher. */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  try {
    const operatorFeeds = materializeOperatorMetadata(ctx);
    const failures = redactFailures(
      operatorFeeds.length === 0
        ? []
        : await runFetchPipeline(operatorFeeds, ctx.runScript, ctx.logger, operatorFeedScript),
    );
    ctx.state.fetchFailures = [...(ctx.state.fetchFailures ?? []), ...failures];
    await persistOutcomes(operatorFeeds, failures, ctx);
    const allFailures = ctx.state.fetchFailures ?? [];
    if (allFailures.length > 0) {
      return {
        stage: "fetch-operator",
        status: "error",
        startedAt,
        finishedAt: ctx.now(),
        durationMs: Date.now() - start,
        message: `Failed to acquire ${allFailures.length} desired transit source(s)`,
        artifacts: { failed: allFailures },
      };
    }
    finalizeTransitSourceManifest(ctx);
    return {
      stage: "fetch-operator",
      status: operatorFeeds.length === 0 ? "skipped" : "ok",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message:
        operatorFeeds.length === 0
          ? "No operator transit sources configured"
          : `Fetched ${operatorFeeds.flatMap((feed) => feed.activeScheduleSources).length} operator source(s)`,
      artifacts: {
        operatorSources: operatorFeeds.flatMap((feed) => feed.activeScheduleSources).length,
      },
    };
  } catch (error) {
    const err = error as Error;
    const message = redactRelayCapability(err.message);
    const stack = scrubSecretsOptional(err.stack)?.replace(
      RELAY_CAPABILITY_PATTERN,
      "/internal/transit/operator-feed/[redacted]",
    );
    return {
      stage: "fetch-operator",
      status: "error",
      startedAt,
      finishedAt: ctx.now(),
      durationMs: Date.now() - start,
      message,
      error: { message, stack },
    };
  }
};
