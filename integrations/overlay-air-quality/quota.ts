import type { QuotaDecision, QuotaWindow, UpstreamRuntime } from "@openmapx/integration-framework";

export const OPENAQ_QUOTA_WINDOWS: readonly QuotaWindow[] = [
  { id: "minute", limit: 50, durationMs: 60_000 },
  { id: "hour", limit: 1_800, durationMs: 3_600_000 },
];

const QUOTA_BUCKET = "openaq-v3";
const COOLDOWN_KEY = "openaq-v3:quota-cooldown:v1";

function delayMilliseconds(value: string | undefined, now: number): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

export function createOpenAQQuota(runtime: UpstreamRuntime, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  return {
    async consume(): Promise<QuotaDecision> {
      const at = now();
      const cooldown = await runtime.read<{ retryAt: number }>(COOLDOWN_KEY, at);
      if (cooldown.state !== "miss" && cooldown.value.retryAt > at) {
        return { allowed: false, remaining: {}, retryAt: cooldown.value.retryAt };
      }
      return runtime.consumeQuota({ bucket: QUOTA_BUCKET, cost: 1, windows: OPENAQ_QUOTA_WINDOWS });
    },

    async observeResponse(
      status: number,
      headers: Readonly<Record<string, string>>,
    ): Promise<void> {
      const at = now();
      const remaining = Number(headers["x-ratelimit-remaining"]);
      if (status !== 429 && (!Number.isFinite(remaining) || remaining > 0)) return;
      const retryAfter = delayMilliseconds(headers["retry-after"], at);
      // OpenAQ documents x-ratelimit-reset as seconds until reset, not a Unix timestamp.
      const reset = delayMilliseconds(headers["x-ratelimit-reset"], at);
      const delay = Math.max(retryAfter ?? 0, reset ?? 0, status === 429 ? 1_000 : 0);
      if (delay <= 0) return;
      const retryAt = at + delay;
      await runtime.write(
        COOLDOWN_KEY,
        { retryAt },
        { softMs: delay, hardMs: delay, staleIfErrorMs: delay },
      );
    },
  };
}
