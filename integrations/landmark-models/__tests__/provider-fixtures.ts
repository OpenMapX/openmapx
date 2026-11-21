import type {
  IntegrationContext,
  LandmarkAsset,
  LandmarkCatalogueSnapshot,
  LandmarkModelFetchResult,
  LandmarkModelProvider,
} from "@openmapx/integration-framework";
import { createMockIntegrationContext } from "@openmapx/integration-framework/testing";

export const BARRELMAN = "landmark-models-barrelman";
export const OPEN = "landmark-models-open-landmarks";
export const SHA = (n: number) => n.toString(16).padStart(64, "0");

let next = 1;
export function testAsset(overrides: Partial<LandmarkAsset> = {}): LandmarkAsset {
  const n = next++;
  return {
    providerAssetId: `a${n}`,
    revision: `r${n}`,
    name: `Asset ${n}`,
    anchor: [2.2945, 48.8584],
    bounds: [2.294, 48.858, 2.295, 48.859],
    elevationM: 0,
    minZoom: 15,
    lods: { low: { sha256: SHA(n), bytes: 100, gzipBytes: 50 } },
    replaces: [],
    grounding: "anchor",
    derivedFootprintAllowed: false,
    reviewTier: "unreviewed",
    sourceId: "src",
    contributors: [{ sourceId: "src", name: "Source" }],
    ...overrides,
  };
}

export interface FakeProvider extends LandmarkModelProvider {
  current: LandmarkCatalogueSnapshot | null;
  fetch: (sha256: string, signal: AbortSignal) => Promise<LandmarkModelFetchResult>;
}

export function fakeProvider(
  id: string,
  assets: LandmarkAsset[] | null,
  release = "r1",
  sourceIds: string[] = ["src", "openstreetmap"],
): FakeProvider {
  const provider: FakeProvider = {
    id,
    sourceIds,
    current: assets ? { release, fetchedAt: "2026-11-20T00:00:00.000Z", assets } : null,
    fetch: async () => ({ status: "unlisted" }),
    snapshot: () => provider.current,
    fetchModelGzip: (sha256, signal) => provider.fetch(sha256, signal),
  };
  return provider;
}

/** A mock context whose `landmark-models` domain holds the given providers. */
export function contextWith(
  providers: FakeProvider[],
  options: { config?: Record<string, unknown>; disallowed?: string[] } = {},
): IntegrationContext {
  const ctx = createMockIntegrationContext({
    id: "landmark-models",
    config: options.config ?? {},
  });
  ctx.getIntegrationsByDomain = () =>
    providers.map(
      (provider) =>
        ({
          id: provider.id,
          enabled: true,
          manifest: { id: provider.id, domains: ["landmark-models"] },
          providers: new Map([["landmark-models", [provider]]]),
        }) as unknown as ReturnType<IntegrationContext["getIntegrationsByDomain"]>[number],
    );
  ctx.getDisallowedSourceIds = async () => new Set(options.disallowed ?? []);
  return ctx;
}
