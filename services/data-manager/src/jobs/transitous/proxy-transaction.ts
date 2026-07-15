import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type FeedProxyVars,
  normalizeFeedProxyVars,
  renderFeedProxyNginxConfig,
} from "@openmapx/motis-feed-proxy-config";
import {
  CANDIDATE_MANIFEST_FILENAME,
  CANDIDATE_PROXY_DIRNAME,
  verifyCandidateManifest,
} from "./candidate.js";
import { FEED_PROXY_CONTAINER } from "./motis-containers.js";
import type { JobContext, ProxyTransactionState, StageFn, StageResult } from "./types.js";

export const ACTIVE_PROXY_ROOT_DIRNAME = "motis-feed-proxy";
const CONFIG_RELATIVE_PATH = join("conf", "default.conf");
const VARS_FILENAME = "feed-proxy-vars.json";

function readOptional(path: string): { existed: boolean; text: string } {
  return existsSync(path)
    ? { existed: true, text: readFileSync(path, "utf-8") }
    : { existed: false, text: "" };
}

function writeAtomic(path: string, text: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, text, "utf-8");
  renameSync(temporary, path);
}

function restore(path: string, previous: { existed: boolean; text: string }): void {
  if (previous.existed) writeAtomic(path, previous.text);
  else rmSync(path, { force: true });
}

function parseVars(text: string, label: string): FeedProxyVars {
  if (!text.trim()) return {};
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new Error(`${label} is malformed JSON: ${(error as Error).message}`);
  }
  return normalizeFeedProxyVars(value);
}

function mergeWithoutAmbiguity(current: FeedProxyVars, candidate: FeedProxyVars): FeedProxyVars {
  const merged: FeedProxyVars = { ...current };
  for (const [id, entry] of Object.entries(candidate)) {
    const old = merged[id];
    if (old && JSON.stringify(old) !== JSON.stringify(entry)) {
      throw new Error(
        `feed-proxy route ${id} changed while the primary still uses it; an isolated two-slot proxy host is required`,
      );
    }
    merged[id] = entry;
  }
  return merged;
}

async function validateAndReload(ctx: JobContext): Promise<void> {
  await ctx.runner("docker", ["exec", FEED_PROXY_CONTAINER, "nginx", "-t"], {
    cwd: ctx.dataDir,
    stdio: "pipe",
  });
  await ctx.runner("docker", ["exec", FEED_PROXY_CONTAINER, "nginx", "-s", "reload"], {
    cwd: ctx.dataDir,
    stdio: "pipe",
  });
}

async function restoreAndReload(ctx: JobContext, state: ProxyTransactionState): Promise<void> {
  restore(state.activeConfigPath, state.previousConfig);
  restore(state.activeVarsPath, state.previousVars);
  try {
    await validateAndReload(ctx);
  } finally {
    state.phase = "rolled-back";
  }
}

export async function rollbackProxyTransaction(ctx: JobContext): Promise<void> {
  const state = ctx.state.proxyTransaction;
  if (state?.phase !== "staged") return;
  await restoreAndReload(ctx, state);
}

/** Prune old routes only after the promoted primary passed its post-activation gate. */
export async function commitProxyTransaction(ctx: JobContext): Promise<void> {
  const state = ctx.state.proxyTransaction;
  if (state?.phase !== "staged") return;
  try {
    writeAtomic(state.activeConfigPath, state.candidateConfig);
    writeAtomic(state.activeVarsPath, state.candidateVars);
    await validateAndReload(ctx);
    state.phase = "committed";
  } catch (error) {
    await restoreAndReload(ctx, state);
    throw new Error(
      `feed-proxy commit failed and previous routing was restored: ${(error as Error).message}`,
    );
  }
}

/** Activate an old+candidate route union while staging imports and probes. */
export const run: StageFn = async (ctx) => {
  const startedAt = ctx.now();
  const start = Date.now();
  const finish = (
    status: StageResult["status"],
    message: string,
    artifacts?: Record<string, unknown>,
  ): StageResult => ({
    stage: "stage-proxy",
    status,
    startedAt,
    finishedAt: ctx.now(),
    durationMs: Date.now() - start,
    message,
    artifacts,
  });
  try {
    if (!existsSync(join(ctx.motisStagingDataDir, CANDIDATE_MANIFEST_FILENAME))) {
      return finish("skipped", "no assembled MOTIS candidate; feed-proxy transaction not needed");
    }
    const manifest = verifyCandidateManifest(ctx.motisStagingDataDir);
    const candidateRoot = join(ctx.motisStagingDataDir, CANDIDATE_PROXY_DIRNAME);
    const candidateConfigPath = join(candidateRoot, CONFIG_RELATIVE_PATH);
    const candidateVarsPath = join(candidateRoot, VARS_FILENAME);
    const candidateConfig = readFileSync(candidateConfigPath, "utf-8");
    const candidateVars = readFileSync(candidateVarsPath, "utf-8");
    const candidate = parseVars(candidateVars, candidateVarsPath);

    const activeRoot = join(ctx.dataDir, ACTIVE_PROXY_ROOT_DIRNAME);
    const activeConfigPath = join(activeRoot, CONFIG_RELATIVE_PATH);
    const activeVarsPath = join(activeRoot, VARS_FILENAME);
    const previousConfig = readOptional(activeConfigPath);
    const previousVars = readOptional(activeVarsPath);
    const current = parseVars(previousVars.text, activeVarsPath);
    const union = mergeWithoutAmbiguity(current, candidate);
    const unionConfig = renderFeedProxyNginxConfig(union);
    const unionVars = `${JSON.stringify(Object.fromEntries(Object.entries(union).sort(([a], [b]) => a.localeCompare(b))), null, 2)}\n`;
    const state: ProxyTransactionState = {
      epoch: manifest.epoch,
      activeConfigPath,
      activeVarsPath,
      previousConfig,
      previousVars,
      candidateConfig,
      candidateVars,
      phase: "staged",
    };
    ctx.state.proxyTransaction = state;
    try {
      writeAtomic(activeConfigPath, unionConfig);
      writeAtomic(activeVarsPath, unionVars);
      await validateAndReload(ctx);
    } catch (error) {
      await restoreAndReload(ctx, state);
      throw new Error(
        `feed-proxy activation failed and previous routing was restored: ${(error as Error).message}`,
      );
    }
    return finish("ok", `staged feed-proxy union for candidate ${manifest.epoch}`, {
      candidateEpoch: manifest.epoch,
      previousEntries: Object.keys(current).length,
      candidateEntries: Object.keys(candidate).length,
      activeEntries: Object.keys(union).length,
    });
  } catch (error) {
    return finish("error", (error as Error).message, { rollback: true });
  }
};
