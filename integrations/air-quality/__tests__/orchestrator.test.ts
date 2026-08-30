import type {
  AirQualityProvider,
  IntegrationContext,
  LoadedIntegration,
  ProviderHealthSnapshot,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createAirQualityOrchestrator } from "../orchestrator.js";

const query = {
  latitude: 52.52,
  longitude: 13.405,
  evaluatedAt: "2026-08-30T12:00:00Z",
};

function provider(id: string, getCurrent: AirQualityProvider["getCurrent"]): AirQualityProvider {
  return {
    id,
    sourceIds: [`${id}-source`],
    priority: 10,
    timeoutMs: 250,
    capabilities: new Set(["current", "pollutants"]),
    coverage: { bbox: [-180, -90, 180, 90] },
    getCurrent,
  };
}

function integration(
  p: AirQualityProvider,
  input: Partial<LoadedIntegration> = {},
): LoadedIntegration {
  return {
    id: `${p.id}-integration`,
    manifest: {
      id: `${p.id}-integration`,
      version: "1.0.0",
      domains: ["air-quality"],
      dataSources: [{ sourceId: `${p.id}-source`, name: "Source", url: "https://example.test" }],
    } as LoadedIntegration["manifest"],
    config: {},
    directory: "/fixture",
    isBuiltIn: true,
    enabled: true,
    providers: new Map([["air-quality", [p]]]),
    strings: {},
    shutdownHandlers: [],
    ...input,
  };
}

function context(integrations: LoadedIntegration[]) {
  const ctx = createMockIntegrationContext({ id: "air-quality" });
  Object.assign(ctx, { getIntegrationsByDomain: () => integrations });
  return ctx as IntegrationContext;
}

afterEach(() => vi.useRealTimers());

describe("canonical air-quality orchestrator", () => {
  it("discovers providers on each request instead of capturing setup state", async () => {
    const integrations: LoadedIntegration[] = [];
    const ctx = context(integrations);
    const orchestrator = createAirQualityOrchestrator(ctx);
    expect((await orchestrator.current(query)).diagnostics.providersCandidate).toEqual([]);

    const call = vi.fn(async () => []);
    integrations.push(integration(provider("late", call)));
    expect((await orchestrator.current(query)).diagnostics.providersCandidate).toEqual(["late"]);
    expect(call).toHaveBeenCalledTimes(1);

    integrations.splice(0);
    expect((await orchestrator.current(query)).diagnostics.providersCandidate).toEqual([]);
  });

  it("skips disabled, wrong-domain, and invalid provider registrations", async () => {
    const valid = provider(
      "valid",
      vi.fn(async () => []),
    );
    const integrations = [
      integration(valid),
      integration(provider("disabled", vi.fn()), { enabled: false }),
      integration(provider("wrong", vi.fn()), {
        manifest: { id: "wrong", version: "1", domains: ["weather"] } as never,
      }),
      { ...integration(provider("invalid", vi.fn())), providers: new Map([["air-quality", [{}]]]) },
    ];
    const result = await createAirQualityOrchestrator(context(integrations)).current(query);
    expect(result.diagnostics.providersCandidate).toEqual(["valid"]);
  });

  it("applies per-source policy before dispatch", async () => {
    const call = vi.fn(async () => []);
    const recordAirQualityProviderCall = vi.fn();
    const ctx = context([integration(provider("model", call))]);
    Object.assign(ctx, {
      getDisallowedSourceIds: async () => new Set(["model-source"]),
      metricsRecorder: { recordAirQualityProviderCall },
    });
    const result = await createAirQualityOrchestrator(ctx).current(query);
    expect(call).not.toHaveBeenCalled();
    expect(result.diagnostics.providersPolicyExcluded).toEqual(["model"]);
    expect(recordAirQualityProviderCall).toHaveBeenCalledWith({
      providerId: "model",
      method: "current",
      outcome: "skipped",
      cacheResult: "bypass",
      suppression: "policy",
      latencyMs: 0,
    });
  });

  it("suppresses an open provider without a half-open claim", async () => {
    const call = vi.fn(async () => []);
    const recordAirQualityProviderCall = vi.fn();
    const snapshot = {
      state: "open",
      ownsHalfOpenProbe: false,
    } as ProviderHealthSnapshot;
    const ctx = context([integration(provider("open", call))]);
    Object.assign(ctx, {
      providerHealth: {
        getSnapshot: vi.fn(async () => snapshot),
        isHealthy: vi.fn(),
        recordSuccess: vi.fn(),
        recordFailure: vi.fn(),
      },
      metricsRecorder: { recordAirQualityProviderCall },
    });
    const result = await createAirQualityOrchestrator(ctx).current(query);
    expect(call).not.toHaveBeenCalled();
    expect(result.diagnostics.providersFailed).toEqual([
      { providerId: "open", code: "provider_unhealthy" },
    ]);
    expect(recordAirQualityProviderCall).toHaveBeenCalledWith({
      providerId: "open",
      method: "current",
      outcome: "skipped",
      cacheResult: "bypass",
      suppression: "health",
      latencyMs: 0,
    });
  });

  it("isolates a failed sibling and records successful/failed providers", async () => {
    const good = provider("good", async () => []);
    const bad = provider("bad", async () => {
      throw new Error("connection reset");
    });
    const recordAirQualityProviderCall = vi.fn();
    const ctx = context([integration(good), integration(bad)]);
    Object.assign(ctx, { metricsRecorder: { recordAirQualityProviderCall } });
    const result = await createAirQualityOrchestrator(ctx).current(query);
    expect(result.diagnostics.providersServed).toEqual(["good"]);
    expect(result.diagnostics.providersFailed).toEqual([
      { providerId: "bad", code: "upstream_failure" },
    ]);
    expect(recordAirQualityProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "good", method: "current", outcome: "empty" }),
    );
    expect(recordAirQualityProviderCall).toHaveBeenCalledWith(
      expect.objectContaining({ providerId: "bad", method: "current", outcome: "error" }),
    );
  });

  it("bounds a provider that ignores cancellation", async () => {
    vi.useFakeTimers();
    const stuck = provider("stuck", () => new Promise(() => {}));
    const pending = createAirQualityOrchestrator(context([integration(stuck)])).current(query);
    await vi.advanceTimersByTimeAsync(251);
    await expect(pending).resolves.toMatchObject({
      diagnostics: {
        providersFailed: [{ providerId: "stuck", code: "provider_timeout" }],
      },
    });
  });
});
