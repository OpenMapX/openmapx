import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { applyHardlinkPlan, type HardlinkEntry } from "@openmapx/hardlinks";
import {
  type FeedProxyVars,
  normalizeFeedProxyVars,
  renderFeedProxyNginxConfig,
} from "@openmapx/motis-feed-proxy-config";
import { runOpsOperation } from "../../ops-client.js";
import {
  CANDIDATE_MANIFEST_FILENAME,
  CANDIDATE_PROXY_DIRNAME,
  verifyCandidateManifest,
} from "./candidate.js";
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

/**
 * Merge the live (`current`) and candidate feed-proxy route maps into the union
 * the shared nginx serves during the staging overlap window.
 *
 * Candidate-only routes are added; current-only routes stay live for the
 * still-running primary; a route present in both takes the CANDIDATE value.
 * When a feed's upstream changed (e.g. a rotated `de-CallaBike` key or URL) the
 * primary keeps the same `/feed/<id>` location — now pointing at the refreshed
 * upstream for the same logical feed, which is what it wants, since the old
 * value is the stale one. This mirrors upstream Transitous (re-render + reload
 * of the one config); the difference is the pipeline still restores the exact
 * previous bytes on any failure downstream, so a bad candidate self-heals.
 *
 * (Earlier this refused a changed route and asked for a "two-slot proxy host"
 * that was never built, which failed the whole pipeline closed whenever any
 * feed rotated its credentials.)
 */
function mergeFeedProxyVars(current: FeedProxyVars, candidate: FeedProxyVars): FeedProxyVars {
  return { ...current, ...candidate };
}

const FEED_PROXY_DATA_TYPE = "motis-feed-proxy-config";

/**
 * Re-establish the hardlink from the pipeline-written `conf/` producer dir to
 * the dir the feed-proxy container actually mounts (`motis-feed-proxy-config/`).
 *
 * The container mounts a *hardlinked copy* of the producer dir, not the producer
 * dir itself. `writeAtomic` (write-tmp + rename) gives each new config a fresh
 * inode, orphaning the previously-linked copy — so without re-linking here nginx
 * keeps serving the stale config no matter how often we `nginx -s reload`. This
 * repairs the link (linkFileAt rm+relinks on inode mismatch) before every
 * validate/reload. Best-effort: on dev/test hosts with no hardlink plan it's a
 * no-op and the (already co-located) config is served directly.
 */
function relinkFeedProxyConfig(ctx: JobContext): void {
  if (!ctx.repoRoot) return;
  const planPath = join(ctx.repoRoot, "infra", "docker", "docker-compose.generated.hardlinks.json");
  if (!existsSync(planPath)) return;
  let plan: HardlinkEntry[];
  try {
    plan = JSON.parse(readFileSync(planPath, "utf-8")) as HardlinkEntry[];
  } catch {
    return;
  }
  const entries = plan.filter((entry) => entry?.dataType === FEED_PROXY_DATA_TYPE);
  if (entries.length === 0) return;
  // prune: false — never delete container-side files (e.g. an operator resolver
  // drop-in); we only need the config file itself re-pointed at the fresh inode.
  applyHardlinkPlan(entries, { rootDir: ctx.dataDir, prune: false });
}

async function validateAndReload(ctx: JobContext): Promise<void> {
  // Propagate the just-written config into the container's mounted copy before
  // asking nginx to validate/reload it.
  relinkFeedProxyConfig(ctx);
  // The agent validates the configuration and only then reloads, so a bad
  // candidate can never take the proxy down.
  await runOpsOperation({
    kind: "feedProxy.validateAndReload",
    // The mtime of the config just written identifies the candidate being
    // activated; the agent needs only that opaque id.
    candidateId: `feedproxy-${Math.trunc(statSync(join(ctx.dataDir, ACTIVE_PROXY_ROOT_DIRNAME, CONFIG_RELATIVE_PATH)).mtimeMs)}`,
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
    const union = mergeFeedProxyVars(current, candidate);
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
