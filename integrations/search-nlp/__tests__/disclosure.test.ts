import type { AiCloudProcessor, NlpProvider } from "@openmapx/integration-framework";
import { describe, expect, it, vi } from "vitest";
import { computeAiSearchDisclosure } from "../index";

function provider(options: {
  id: string;
  ai: boolean;
  cloud: boolean;
  processors?: AiCloudProcessor[];
}): NlpProvider {
  return {
    id: options.id,
    label: options.id,
    cacheKey: options.id,
    isAi: options.ai,
    requiresNetwork: options.cloud,
    cloudProcessors: options.processors ?? [],
    parseQuery: vi.fn(),
  };
}

const google: AiCloudProcessor = {
  id: "google",
  name: "Google (Gemini)",
  countryCode: "US",
  privacyUrl: "https://policies.google.com/privacy",
};

describe("computeAiSearchDisclosure", () => {
  it("does not present the deterministic keyword fallback as AI", () => {
    const disclosure = computeAiSearchDisclosure([
      provider({ id: "keyword", ai: false, cloud: false }),
    ]);
    expect(disclosure).toMatchObject({
      type: "ai-search",
      integrationId: "search-nlp",
      aiActive: false,
      localActive: false,
      cloudActive: false,
      cloudProcessors: [],
    });
  });

  it("reports local AI without a cloud processor", () => {
    const disclosure = computeAiSearchDisclosure([
      provider({ id: "local", ai: true, cloud: false }),
      provider({ id: "keyword", ai: false, cloud: false }),
    ]);
    expect(disclosure.aiActive).toBe(true);
    expect(disclosure.localActive).toBe(true);
    expect(disclosure.cloudActive).toBe(false);
  });

  it("publishes configured processor metadata and de-duplicates it", () => {
    const disclosure = computeAiSearchDisclosure([
      provider({ id: "gemini-fast", ai: true, cloud: true, processors: [google] }),
      provider({ id: "gemini-quality", ai: true, cloud: true, processors: [google] }),
    ]);
    expect(disclosure.cloudActive).toBe(true);
    expect(disclosure.cloudProcessors).toEqual([google]);
  });
});
