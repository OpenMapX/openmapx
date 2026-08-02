import { feedState } from "@openmapx/db-schema";
import { db as defaultDb } from "../../db/index.js";
import { scrubSecrets, scrubSecretsOptional } from "../../utils/scrub-secrets.js";

/**
 * Per-feed staleness + consecutive-failure alerting.
 *
 * Two triggers:
 *   - `stale`: `last_fetched_at` is older than `staleAfterHours` (default 48h).
 *   - `consecutive-failures`: `consecutive_failures >= failuresThreshold`
 *     (default 3).
 *
 * Output:
 *   - Always: a structured log line per alert (warn level).
 *   - Optional: a GitHub Issue per alert when the `githubIssue` sink is
 *     supplied. The sink is expected to dedupe by title.
 */

export type FeedAlertKind = "stale" | "consecutive-failures";

export interface FeedAlert {
  region: string;
  name: string;
  kind: FeedAlertKind;
  threshold: { hoursStale?: number; consecutiveFailures?: number };
  detail: {
    lastFetchedAt?: string;
    hoursStale?: number;
    consecutiveFailures?: number;
    validationMessage?: string;
  };
}

export interface AlertLogger {
  info: (msg: string, extra?: Record<string, unknown>) => void;
  warn: (msg: string, extra?: Record<string, unknown>) => void;
  error: (msg: string, extra?: Record<string, unknown>) => void;
  /** Optional. Receives unscrubbed diagnostics; off unless LOG_LEVEL=debug. */
  debug?: (msg: string, extra?: Record<string, unknown>) => void;
}

export interface GithubIssueSink {
  /** Create (or reuse) a GitHub Issue. Returns the issue URL. */
  createIssue: (title: string, body: string) => Promise<string>;
  /** Search currently-open issues to dedupe. Returns the URL if a match exists. */
  findOpenIssueByTitle?: (title: string) => Promise<string | null>;
}

/**
 * Minimal drizzle-like surface that `detectStaleFeeds` exercises. Typed as a
 * structural alias so tests can pass a hand-rolled stub without dragging the
 * full Drizzle types through the spec layer. Production callers omit `db`
 * and get the package-wide singleton.
 */
export type FeedStateReader = {
  select: (columns: {
    region: typeof feedState.region;
    name: typeof feedState.name;
    lastFetchedAt: typeof feedState.lastFetchedAt;
    validationMessage: typeof feedState.validationMessage;
    consecutiveFailures: typeof feedState.consecutiveFailures;
  }) => {
    from: (table: typeof feedState) => PromiseLike<
      Array<{
        region: string;
        name: string;
        lastFetchedAt: Date | null;
        validationMessage: string | null;
        consecutiveFailures: number;
      }>
    >;
  };
};

export interface DetectStaleFeedsOptions {
  /** Drizzle handle; defaults to the package-wide singleton. */
  db?: FeedStateReader;
  /** Anything older than this is "stale". Defaults to 48h. */
  staleAfterHours?: number;
  /** Failure count at which to fire the consecutive-failures alert. Defaults to 3. */
  failuresThreshold?: number;
  /** Test seam: override the wall clock. */
  now?: () => Date;
}

export interface EmitFeedAlertsOptions {
  alerts: FeedAlert[];
  log: AlertLogger;
  /** Optional. When omitted only the log sink runs. */
  githubIssue?: GithubIssueSink;
}

const DEFAULT_STALE_AFTER_HOURS = 48;
const DEFAULT_FAILURES_THRESHOLD = 3;

/**
 * Scan `data_manager.feed_state` and surface every row that crossed either
 * threshold. A single feed can produce both kinds (very stale AND repeatedly
 * failing) — each kind generates its own `FeedAlert` so downstream
 * deduplication operates on `(region, name, kind)`.
 */
export async function detectStaleFeeds(opts: DetectStaleFeedsOptions = {}): Promise<FeedAlert[]> {
  const handle: FeedStateReader = opts.db ?? (defaultDb as unknown as FeedStateReader);
  const staleAfterHours = opts.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;
  const failuresThreshold = opts.failuresThreshold ?? DEFAULT_FAILURES_THRESHOLD;
  const now = opts.now ? opts.now() : new Date();

  const rows = await handle
    .select({
      region: feedState.region,
      name: feedState.name,
      lastFetchedAt: feedState.lastFetchedAt,
      validationMessage: feedState.validationMessage,
      consecutiveFailures: feedState.consecutiveFailures,
    })
    .from(feedState);

  const alerts: FeedAlert[] = [];
  const staleCutoffMs = now.getTime() - staleAfterHours * 3600 * 1000;

  for (const row of rows) {
    // Trigger 1: stale. We only fire when `last_fetched_at` is known — a row
    // that has never recorded a fetch yet is `unknown` rather than stale.
    if (row.lastFetchedAt) {
      const fetchedMs = new Date(row.lastFetchedAt).getTime();
      if (fetchedMs < staleCutoffMs) {
        const hoursStale = (now.getTime() - fetchedMs) / 3600 / 1000;
        alerts.push({
          region: row.region,
          name: row.name,
          kind: "stale",
          threshold: { hoursStale: staleAfterHours },
          detail: {
            lastFetchedAt: new Date(row.lastFetchedAt).toISOString(),
            hoursStale: Math.round(hoursStale * 10) / 10,
          },
        });
      }
    }

    // Trigger 2: consecutive validation failures.
    if (row.consecutiveFailures >= failuresThreshold) {
      alerts.push({
        region: row.region,
        name: row.name,
        kind: "consecutive-failures",
        threshold: { consecutiveFailures: failuresThreshold },
        detail: {
          consecutiveFailures: row.consecutiveFailures,
          validationMessage: row.validationMessage ?? undefined,
        },
      });
    }
  }

  return alerts;
}

/**
 * Emit every alert through the configured sinks. The log sink is mandatory
 * and always runs first so structured warnings show up in centralized
 * logging even when the GitHub credentials are missing. The GitHub sink is
 * optional — without `TRANSITOUS_ALERT_GH_TOKEN` + `TRANSITOUS_ALERT_GH_REPO`
 * the caller passes no `githubIssue` argument and this function never
 * touches the network.
 */
export async function emitFeedAlerts(opts: EmitFeedAlertsOptions): Promise<void> {
  for (const alert of opts.alerts) {
    const detail = {
      ...alert.detail,
      validationMessage: scrubSecretsOptional(alert.detail.validationMessage),
    };
    const base = {
      region: alert.region,
      name: alert.name,
      kind: alert.kind,
      ...detail,
    };
    opts.log.warn("transit feed alert", base);

    if (!opts.githubIssue) continue;
    const title = githubIssueTitle(alert);
    const body = githubIssueBody({ ...alert, detail });
    try {
      if (opts.githubIssue.findOpenIssueByTitle) {
        const existing = await opts.githubIssue.findOpenIssueByTitle(title);
        if (existing) {
          opts.log.info("transit feed alert: existing GitHub issue, skipped creation", {
            ...base,
            existing,
          });
          continue;
        }
      }
      const issueUrl = await opts.githubIssue.createIssue(title, body);
      opts.log.info("transit feed alert: GitHub issue created", { ...base, issueUrl });
    } catch (err) {
      opts.log.error("transit feed alert: GitHub issue failed", {
        ...base,
        err: (err as Error).message,
      });
    }
  }
}

/**
 * A whole pipeline run failed (or ended partial) — distinct from a per-feed
 * staleness alert. This is the signal that catches a canary that keeps
 * rejecting candidates: in mirror mode `feed_state.last_fetched_at` is written
 * before the canary runs, so per-feed staleness never fires even while
 * `promote` is stuck and the live dataset silently ages.
 */
export interface PipelineFailureAlert {
  /** What kicked off the run, e.g. "cron" or "auto-bump". Keeps the issue title stable so nightly failures dedupe. */
  trigger: string;
  jobId: string;
  /** The stage that hard-stopped the run, when known (e.g. "motis-health"). */
  failedStage?: string;
  reason: string;
}

/**
 * Emit a pipeline-level failure alert. Always logs at error level; when a
 * GitHub sink is configured, opens (or reuses) a single issue per `trigger`
 * so a run that fails every night doesn't spam a new issue each time. The
 * reason is scrubbed before it reaches any sink; the original is available
 * only at debug level in the data-manager's own container log.
 */
export async function emitPipelineFailureAlert(opts: {
  alert: PipelineFailureAlert;
  log: AlertLogger;
  githubIssue?: GithubIssueSink;
}): Promise<void> {
  const { alert, log, githubIssue } = opts;
  const reason = scrubSecrets(alert.reason);
  const base = {
    trigger: alert.trigger,
    jobId: alert.jobId,
    failedStage: alert.failedStage,
    reason,
  };
  log.error("transit pipeline failure", base);
  if (reason !== alert.reason) {
    log.debug?.("transit pipeline failure: unscrubbed reason", {
      jobId: alert.jobId,
      reason: alert.reason,
    });
  }

  if (!githubIssue) return;
  const title = `Transit pipeline failed: ${alert.trigger}`;
  const body = [
    "Automatic alert from the openmapx data-manager.",
    "",
    `- trigger: \`${alert.trigger}\``,
    `- jobId: \`${alert.jobId}\``,
    ...(alert.failedStage ? [`- failedStage: \`${alert.failedStage}\``] : []),
    `- reason: \`${reason}\``,
  ].join("\n");
  try {
    if (githubIssue.findOpenIssueByTitle) {
      const existing = await githubIssue.findOpenIssueByTitle(title);
      if (existing) {
        log.info("transit pipeline failure: existing GitHub issue, skipped creation", {
          ...base,
          existing,
        });
        return;
      }
    }
    const issueUrl = await githubIssue.createIssue(title, body);
    log.info("transit pipeline failure: GitHub issue created", { ...base, issueUrl });
  } catch (err) {
    log.error("transit pipeline failure: GitHub issue failed", {
      ...base,
      err: (err as Error).message,
    });
  }
}

/**
 * Resolve a GitHub Issue title that uniquely identifies the (region, name, kind)
 * tuple. The dedup path searches for an open issue with this exact title so
 * the format must remain stable across releases.
 */
export function githubIssueTitle(alert: FeedAlert): string {
  const prefix = alert.kind === "stale" ? "Stale transit feed" : "Failing transit feed";
  return `${prefix}: ${alert.region}/${alert.name}`;
}

function githubIssueBody(alert: FeedAlert): string {
  const lines: string[] = [];
  lines.push(`Automatic alert from the openmapx data-manager.`);
  lines.push("");
  lines.push(`- region: \`${alert.region}\``);
  lines.push(`- name: \`${alert.name}\``);
  lines.push(`- kind: \`${alert.kind}\``);
  if (alert.threshold.hoursStale !== undefined) {
    lines.push(`- threshold (hours): \`${alert.threshold.hoursStale}\``);
  }
  if (alert.threshold.consecutiveFailures !== undefined) {
    lines.push(`- threshold (failures): \`${alert.threshold.consecutiveFailures}\``);
  }
  if (alert.detail.lastFetchedAt) {
    lines.push(`- lastFetchedAt: \`${alert.detail.lastFetchedAt}\``);
  }
  if (alert.detail.hoursStale !== undefined) {
    lines.push(`- hoursStale: \`${alert.detail.hoursStale}\``);
  }
  if (alert.detail.consecutiveFailures !== undefined) {
    lines.push(`- consecutiveFailures: \`${alert.detail.consecutiveFailures}\``);
  }
  if (alert.detail.validationMessage) {
    lines.push(`- validationMessage: \`${alert.detail.validationMessage}\``);
  }
  return lines.join("\n");
}

/**
 * Helper that builds a `GithubIssueSink` from raw token + repo strings. Returns
 * `null` when either argument is missing so callers can wire the env-var
 * lookup without conditionals.
 */
export function buildGithubIssueSink(
  token: string | undefined,
  repo: string | undefined,
): GithubIssueSink | null {
  if (!token || !repo) return null;
  const apiBase = `https://api.github.com/repos/${repo}`;
  return {
    async findOpenIssueByTitle(title: string): Promise<string | null> {
      const url = `${apiBase}/issues?state=open&per_page=100`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
        },
      });
      if (!res.ok) {
        throw new Error(`GitHub list issues failed: ${res.status} ${res.statusText}`);
      }
      const issues = (await res.json()) as Array<{ title: string; html_url: string }>;
      const match = issues.find((issue) => issue.title === title);
      return match ? match.html_url : null;
    },
    async createIssue(title: string, body: string): Promise<string> {
      const res = await fetch(`${apiBase}/issues`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ title, body }),
      });
      if (!res.ok) {
        throw new Error(`GitHub create issue failed: ${res.status} ${res.statusText}`);
      }
      const issue = (await res.json()) as { html_url: string };
      return issue.html_url;
    },
  };
}
