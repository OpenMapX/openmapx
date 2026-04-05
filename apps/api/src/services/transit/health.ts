const MAX_FAILURES = 5;
const DISABLE_MS = 5 * 60 * 1000; // 5 minutes

interface ProviderState {
  failures: number;
  disabledUntil: number;
}

class ProviderHealth {
  private state = new Map<string, ProviderState>();

  /** Check if a provider should be queried (not disabled). */
  isHealthy(id: string): boolean {
    const s = this.state.get(id);
    if (!s) return true;
    if (s.disabledUntil > Date.now()) return false;
    // Cooldown expired — re-enable
    if (s.disabledUntil > 0) {
      s.failures = 0;
      s.disabledUntil = 0;
    }
    return true;
  }

  /** Record a successful response from a provider. */
  recordSuccess(id: string): void {
    this.state.delete(id);
  }

  /** Record a failed response. After MAX_FAILURES consecutive, disable for DISABLE_MS. */
  recordFailure(id: string): void {
    const s = this.state.get(id) ?? { failures: 0, disabledUntil: 0 };
    s.failures++;
    if (s.failures >= MAX_FAILURES) {
      s.disabledUntil = Date.now() + DISABLE_MS;
    }
    this.state.set(id, s);
  }

  /** Reset health state for a specific provider (e.g., after integration reload). */
  reset(id: string): void {
    this.state.delete(id);
  }

  /** Get all tracked provider states (for debug endpoint). */
  getStatus(): Record<string, { healthy: boolean; failures: number; disabledUntil?: string }> {
    const result: Record<string, { healthy: boolean; failures: number; disabledUntil?: string }> =
      {};
    for (const [id, s] of this.state) {
      const healthy = this.isHealthy(id);
      result[id] = {
        healthy,
        failures: s.failures,
        disabledUntil:
          s.disabledUntil > Date.now() ? new Date(s.disabledUntil).toISOString() : undefined,
      };
    }
    return result;
  }
}

export const providerHealth = new ProviderHealth();
